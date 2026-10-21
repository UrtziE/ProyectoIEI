import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import connectDB from '../config/database';
import Entidad, { Ambito } from '../models/Entidad';
import Localidad from '../models/Localidad';
import Provincia from '../models/Provincia';

const UNKNOWN_VALUE = '_U';
const DEFAULT_CAN_FILE = path.resolve(process.cwd(), 'src/public/fuentes_de_datos/Can.json');

interface CanRecord {
    denominacion?: string;
    pagina_web?: string;
    area_nombre?: string;
    subarea_nombre?: string;
    direccion_provincia_nombre?: string;
    direccion_municipio_nombre?: string;
}

interface ImportSummary {
    provincias: number;
    localidades: number;
    entidades: number;
}

const asRequiredString = (value: string | undefined, field: string, index: number): string => {
    if (!value || value === UNKNOWN_VALUE || value.trim() === '') {
        throw new Error(`El registro ${index + 1} no tiene un valor válido para ${field}.`);
    }

    return value.trim();
};

const optionalCopiedValue = (value: string | undefined): string | undefined => {
    if (!value || value === UNKNOWN_VALUE || value.trim() === '') {
        return undefined;
    }

    return value.trim();
};

const getAmbito = (area: string, subarea: string | undefined): Ambito => {
    switch (area) {
        case 'Tercera Edad':
            return 'MAYORES';
        case 'Discapacidad':
            return 'DISCAPACIDAD';
        case 'Menores Y Juventud':
            return 'INFANCIA_Y_JUVENTUD';
        case 'Drogodependencia':
            return 'SALUD_Y_ATENCION_SOCIOSANITARIA';
        case 'Exclusión Social':
            return 'INCLUSION_SOCIAL';
        case 'Voluntariado':
            return 'VOLUNTARIADO_Y_PARTICIPACION_COMUNITARIA';
        case 'Varios':
            if (subarea === 'Otros' || subarea === UNKNOWN_VALUE) {
                return 'VOLUNTARIADO_Y_PARTICIPACION_COMUNITARIA';
            }
            if (subarea === 'Comedores Sociales Casas Hogar Comunidades Religiosas Talleres Sociales Desarrollo Social E Inserción Social Y Fomento Y Empleo') {
                return 'INCLUSION_SOCIAL';
            }
            break;
    }

    throw new Error(`No existe un mapping de ambito para area "${area}" y subarea "${subarea ?? UNKNOWN_VALUE}".`);
};

const readCanFile = async (filePath: string): Promise<CanRecord[]> => {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(content);

    if (!Array.isArray(parsed)) {
        throw new Error(`El fichero ${filePath} debe contener un array JSON.`);
    }

    return parsed as CanRecord[];
};

export const extractCAN = async (filePath = DEFAULT_CAN_FILE): Promise<ImportSummary> => {
    const records = await readCanFile(filePath);
    const summary: ImportSummary = {
        provincias: 0,
        localidades: 0,
        entidades: 0
    };

    for (const [index, record] of records.entries()) {
        const nombre = asRequiredString(record.denominacion, 'denominacion', index);
        const provinciaNombre = asRequiredString(record.direccion_provincia_nombre, 'direccion_provincia_nombre', index);
        const localidadNombre = asRequiredString(record.direccion_municipio_nombre, 'direccion_municipio_nombre', index);
        const area = asRequiredString(record.area_nombre, 'area_nombre', index);
        const ambito = getAmbito(area, optionalCopiedValue(record.subarea_nombre));
        const url = optionalCopiedValue(record.pagina_web);

        const provincia = await Provincia.findOneAndUpdate(
            { nombre: provinciaNombre },
            { nombre: provinciaNombre },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).exec();
        summary.provincias += 1;

        const localidad = await Localidad.findOneAndUpdate(
            { nombre: localidadNombre, provincia: provincia._id },
            { nombre: localidadNombre, provincia: provincia._id },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).exec();
        summary.localidades += 1;

        const entidadData = {
            nombre,
            ambito,
            localidad: localidad._id,
            ...(url !== undefined
                ? { URL: url }
                : {})
        };

        await Entidad.findOneAndUpdate(
            { nombre, localidad: localidad._id },
            entidadData,
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).exec();
        summary.entidades += 1;
    }

    return summary;
};

const run = async (): Promise<void> => {
    const filePath = process.argv[2]
        ? path.resolve(process.cwd(), process.argv[2])
        : DEFAULT_CAN_FILE;

    await connectDB();
    const summary = await extractCAN(filePath);
    console.log(
        `[CAN] Importación completada: ${summary.provincias} provincias, ` +
        `${summary.localidades} localidades y ${summary.entidades} entidades.`
    );
};

if (require.main === module) {
    run()
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[CAN] Error durante la importación: ${message}`);
            process.exitCode = 1;
        })
        .finally(async () => {
            if (mongoose.connection.readyState !== 0) {
                await mongoose.disconnect();
            }
        });
}
