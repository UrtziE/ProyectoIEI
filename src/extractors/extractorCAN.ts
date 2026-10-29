import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import connectDB from '../config/database';
import Entidad, { Ambito } from '../models/Entidad';
import Localidad from '../models/Localidad';
import Provincia from '../models/Provincia';
import vaciarBaseDatos from '../utils/vaciarBaseDatos';
import {conseguirCoordenadasGPS} from '../robot/seleniumScraper'
const UNKNOWN_VALUE = '_U';
const DEFAULT_CAN_FILE = path.resolve(process.cwd(), 'src/public/fuentes_de_datos/Can.json');

interface CanRecord {
    denominacion?: string;
    numero_registro?: string;
    direccion_tipo_via?: string;
    direccion_nombre_via?: string;
    direccion_numero?: string;
    direccion_complemento?: string;
    direccion_isla_nombre?: string;
    telefono_1?: string;
    telefono_2?: string;
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

const normalizarCategoria = (valor: string | undefined): string => (valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

interface ReglaAmbito {
    area?: string;
    subarea?: string;
    ambito: Ambito;
}

// Cada objeto combina sus campos con AND. Las reglas de un mismo ámbito son OR.
const REGLAS_AMBITO: ReglaAmbito[] = [
    { area: 'Tercera Edad', ambito: 'MAYORES' },
    { area: 'Discapacidad', ambito: 'DISCAPACIDAD' },
    { area: 'Menores Y Juventud', ambito: 'INFANCIA_Y_JUVENTUD' },
    { area: 'Mujer', ambito: 'MUJER' },
    { area: 'Exclusión Social', ambito: 'INCLUSION_SOCIAL' },
    { area: 'Drogodependencia', ambito: 'SALUD_Y_ATENCION_SOCIOSANITARIA' },
    { area: 'Voluntariado', ambito: 'VOLUNTARIADO_Y_PARTICIPACION_COMUNITARIA' },
    { subarea: 'Otros', ambito: 'VOLUNTARIADO_Y_PARTICIPACION_COMUNITARIA' },
    {
        area: 'Varios',
        subarea: 'Comedores Sociales Casas Hogar Comunidades Religiosas Talleres Sociales Desarrollo Social E Inserción Social Y Fomento Y Empleo',
        ambito: 'INCLUSION_SOCIAL'
    },
    { area: 'Varios', subarea: 'Migración', ambito: 'MIGRACION' },
    { area: 'Varios', subarea: 'Discapacidad', ambito: 'DISCAPACIDAD' },
    { area: 'Varios', subarea: 'Centros Ocupacionales', ambito: 'DISCAPACIDAD' },
    { area: 'Varios', subarea: 'Asociaciones de Enfermos', ambito: 'SALUD_MENTAL' },
    { area: 'Varios', subarea: 'Enfermos Relacionadas Con El Asilo Socio Sanitario Organizaciones Relacionadas Con Autoayuda Terapias Y Salud', ambito: 'SALUD_MENTAL' },
    { area: 'Varios', subarea: 'Mujer', ambito: 'MUJER' },
    { area: 'Varios', subarea: 'Exclusión Social II', ambito: 'INCLUSION_SOCIAL' },
    { area: 'Varios', subarea: 'Asociaciones De Igualdad Lgtbi', ambito: 'INCLUSION_SOCIAL' },
    { area: 'Varios', subarea: 'Asociaciones Sociales Casas Hogar Comunidades Religiosas Talleres Sociales Desarrollo Social E Inserción Social Y Fomento Y Empleo', ambito: 'INCLUSION_SOCIAL' },
    { area: 'Varios', subarea: 'Ciencia Tecnología Investigación E Innovación Medio Ambiente Ecología Patrimonio Histórico Cultural', ambito: 'EDUCACION_Y_FORMACION' },
    { area: 'Varios', subarea: 'Asociaciones De Trabajadores Empresarios Sindicatos Colegios Profesionales Universidades', ambito: 'EMPLEO_E_INSERCION_LABORAL' },
    { area: 'Varios', subarea: 'Drogodependencia', ambito: 'SALUD_Y_ATENCION_SOCIOSANITARIA' },
    { area: 'Varios', subarea: 'Asuntos Sanitarios', ambito: 'SALUD_Y_ATENCION_SOCIOSANITARIA' },
    { area: 'Varios', subarea: 'Asociaciones Culturales', ambito: 'CULTURA_Y_DESARROLLO_COMUNITARIO' },
    { area: 'Varios', subarea: 'Deportivas Socio Educativas Socio Culturales', ambito: 'CULTURA_Y_DESARROLLO_COMUNITARIO' },
    { area: 'Varios', subarea: 'Asociaciones De Vecinos Y Juveniles', ambito: 'CULTURA_Y_DESARROLLO_COMUNITARIO' },
    // El esquema incluye Varios como criterio OR para este ámbito genérico;
    // debe evaluarse al final para respetar antes las subáreas más concretas.
    { area: 'Varios', ambito: 'VOLUNTARIADO_Y_PARTICIPACION_COMUNITARIA' }
];

const getAmbito = (area: string, subarea: string | undefined): Ambito => {
    const areaNormalizada = normalizarCategoria(area);
    const subareaNormalizada = normalizarCategoria(subarea);
    const regla = REGLAS_AMBITO.find(({ area: areaEsperada, subarea: subareaEsperada }) =>
        (areaEsperada === undefined || areaNormalizada === normalizarCategoria(areaEsperada)) &&
        (subareaEsperada === undefined || subareaNormalizada.includes(normalizarCategoria(subareaEsperada)))
    );

    if (regla) return regla.ambito;

    throw new Error(`No existe un mapping de ambito para area "${area}" y subarea "${subarea ?? UNKNOWN_VALUE}".`);
};

const getDireccion = (record: CanRecord): string => {
    const via = [
        record.direccion_tipo_via,
        record.direccion_nombre_via,
        record.direccion_numero
    ]
        .map(optionalCopiedValue)
        .filter((value): value is string => value !== undefined)
        .join(' ');
    const ubicacion = [
        record.direccion_complemento,
        record.direccion_municipio_nombre,
        record.direccion_provincia_nombre
    ]
        .map(optionalCopiedValue)
        .filter((value): value is string => value !== undefined)
        .join(', ');

    return [via, ubicacion].filter((value) => value !== '').join(', ');
};

const getContactOrDescription = (parte1: string | undefined, parte2: string |undefined): string => {
    const parte1Value = optionalCopiedValue(parte1);
    const parte2Value = optionalCopiedValue(parte2);
    if (parte1Value && parte2Value) {
        return parte1Value + ' / ' + parte2Value;
    }  
    if (parte1Value) {
        return parte1Value;
    }
    if (parte2Value) {
        return parte2Value;
    }
    return 'No disponible';
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
    await vaciarBaseDatos();

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
        const direccion = getDireccion(record);
        const descripcion = getContactOrDescription(record.subarea_nombre, record.area_nombre);
        const contacto= getContactOrDescription(record.telefono_1, record.telefono_2);
        const coordenadas = await conseguirCoordenadasGPS(direccion);
        const codigoPostal = coordenadas.codigo_postal?.trim();

        if (!codigoPostal || (!codigoPostal.startsWith('35') && !codigoPostal.startsWith('38'))) {
            console.warn(
                `[CAN] Se omite el registro ${index + 1} ("${nombre}"): ` +
                `código postal fuera de Canarias o no encontrado ("${codigoPostal ?? ''}").`
            );
            continue;
        }

        const longitud = coordenadas.longitud ? parseFloat(coordenadas.longitud) : undefined;
        const latitud = coordenadas.latitud ? parseFloat(coordenadas.latitud) : undefined;
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
            direccion,
            codigo_postal: codigoPostal,
            longitud,
            latitud,
            descripcion,
            contacto,
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
