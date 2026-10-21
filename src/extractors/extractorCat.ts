import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { convertXML } from 'simple-xml-to-json';
import connectDB from '../config/database';
import Entidad, { Ambito } from '../models/Entidad';
import Localidad from '../models/Localidad';
import Provincia from '../models/Provincia';

const DEFAULT_CAT_FILE = path.resolve(process.cwd(), 'src/public/fuentes_de_datos/Cat.xml');
const CAT_AMBITO: Ambito = 'SIN_CLASIFICAR';

const PROVINCE_BY_POSTAL_PREFIX: Record<string, string> = {
    '08': 'Barcelona',
    '17': 'Girona',
    '25': 'Lleida',
    '43': 'Tarragona'
};

interface ConvertedField {
    content?: string;
}

type ConvertedEntityField = Record<string, ConvertedField>;

interface ConvertedCatEntity {
    children?: ConvertedEntityField[];
}

interface ConvertedCatDocument {
    registre_ongd?: {
        children?: Array<{ entitat?: ConvertedCatEntity }>;
    };
}

interface CatRecord {
    numeroRegistro?: string;
    nombre?: string;
    naturaleza?: string;
    cif?: string;
    direccion?: string;
    codigoPostal?: string;
    municipio?: string;
    telefono?: string;
    movil?: string;
    email?: string;
    web?: string;
}

interface PreparedCatRecord {
    nombre: string;
    provincia: string;
    municipio: string;
    codigoPostal?: string;
    direccion?: string;
    url?: string;
    contacto?: string;
    descripcion?: string;
    ambito: Ambito;
}

interface ImportSummary {
    provincias: number;
    localidades: number;
    entidades: number;
}

const optionalValue = (value: string | undefined): string | undefined => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized ? normalized : undefined;
};

const requiredValue = (value: string | undefined, field: string, index: number): string => {
    const normalized = optionalValue(value);
    if (!normalized) {
        throw new Error(`El registro CAT ${index + 1} no tiene un valor válido para ${field}.`);
    }

    return normalized;
};

/**
 * Convierte el XML con simple-xml-to-json y adapta la estructura children/content
 * que genera la librería a registros planos para que el extractor pueda usarlos.
 */
export const readCatRecords = async (filePath = DEFAULT_CAT_FILE): Promise<CatRecord[]> => {
    const xml = await fs.readFile(filePath, 'utf8');
    const converted = convertXML(xml) as ConvertedCatDocument;
    const entities = converted.registre_ongd?.children;

    if (!Array.isArray(entities) || entities.length === 0) {
        throw new Error(`El XML ${filePath} no contiene entidades en registre_ongd.`);
    }

    return entities.map((entry, index) => {
        const fields = entry.entitat?.children;
        if (!Array.isArray(fields)) {
            throw new Error(`El registro CAT ${index + 1} no contiene la etiqueta entitat esperada.`);
        }

        const values: Record<string, string | undefined> = {};
        for (const field of fields) {
            for (const [name, data] of Object.entries(field)) {
                values[name] = optionalValue(data?.content);
            }
        }

        return {
            numeroRegistro: values.n_mero_registre,
            nombre: values.nom_de_l_entitat,
            naturaleza: values.naturalesa,
            cif: values.cif_entitat,
            direccion: values.adre_a,
            codigoPostal: values.codi_postal,
            municipio: values.municipi,
            telefono: values.tel_fon,
            movil: values.tel_fon_m_bil,
            email: values.correu_electr_nic,
            web: values.web
        };
    });
};

const provinceFromPostalCode = (postalCode: string, index: number): string => {
    if (!/^\d{5}$/.test(postalCode)) {
        throw new Error(`El registro CAT ${index + 1} tiene un código postal no válido: "${postalCode}".`);
    }

    const province = PROVINCE_BY_POSTAL_PREFIX[postalCode.slice(0, 2)];
    if (!province) {
        throw new Error(`No se reconoce la provincia del código postal "${postalCode}" en el registro CAT ${index + 1}.`);
    }

    return province;
};

const prepareRecords = (records: CatRecord[]): PreparedCatRecord[] => records.map((record, index) => {
    const nombre = requiredValue(record.nombre, 'nom_de_l_entitat', index);
    const municipio = requiredValue(record.municipio, 'municipi', index);
    const codigoPostal = requiredValue(record.codigoPostal, 'codi_postal', index);
    const provincia = provinceFromPostalCode(codigoPostal, index);

    const descripcion = [
        record.numeroRegistro ? `Número de registro: ${record.numeroRegistro}` : undefined,
        record.naturaleza ? `Naturaleza: ${record.naturaleza}` : undefined,
        record.cif ? `CIF: ${record.cif}` : undefined
    ].filter(Boolean).join(' · ');

    const contacto = [
        record.telefono ? `Teléfono: ${record.telefono}` : undefined,
        record.movil ? `Móvil: ${record.movil}` : undefined,
        record.email ? `Email: ${record.email}` : undefined
    ].filter(Boolean).join(' · ');

    return {
        nombre,
        municipio,
        provincia,
        codigoPostal,
        direccion: optionalValue(record.direccion),
        url: optionalValue(record.web),
        contacto: contacto || undefined,
        descripcion: descripcion || undefined,
        ambito: CAT_AMBITO
    };
});

export const extractCAT = async (filePath = DEFAULT_CAT_FILE): Promise<ImportSummary> => {
    // Primero se valida y normaliza todo el XML, para detectar errores antes de escribir en MongoDB.
    const records = prepareRecords(await readCatRecords(filePath));
    const summary: ImportSummary = { provincias: 0, localidades: 0, entidades: 0 };

    for (const record of records) {
        const provincia = await Provincia.findOneAndUpdate(
            { nombre: record.provincia },
            { nombre: record.provincia },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).exec();
        summary.provincias += 1;

        const localidad = await Localidad.findOneAndUpdate(
            { nombre: record.municipio, provincia: provincia._id },
            { nombre: record.municipio, provincia: provincia._id },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).exec();
        summary.localidades += 1;

        const entidadData = {
            nombre: record.nombre,
            ambito: record.ambito,
            localidad: localidad._id,
            ...(record.codigoPostal ? { codigo_postal: record.codigoPostal } : {}),
            ...(record.direccion ? { direccion: record.direccion } : {}),
            ...(record.url ? { URL: record.url } : {}),
            ...(record.contacto ? { contacto: record.contacto } : {}),
            ...(record.descripcion ? { descripcion: record.descripcion } : {})
        };

        await Entidad.findOneAndUpdate(
            { nombre: record.nombre, localidad: localidad._id },
            entidadData,
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).exec();
        summary.entidades += 1;
    }

    return summary;
};

const run = async (): Promise<void> => {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const filePathArgument = args.find((argument) => argument !== '--dry-run');
    const filePath = filePathArgument
        ? path.resolve(process.cwd(), filePathArgument)
        : DEFAULT_CAT_FILE;

    if (dryRun) {
        const records = prepareRecords(await readCatRecords(filePath));
        console.log(`[CAT] Validación correcta: ${records.length} entidades preparadas. No se ha conectado a MongoDB.`);
        for (const record of records.slice(0, 3)) {
            console.log(`- ${record.nombre} | ${record.municipio}, ${record.provincia} | CP ${record.codigoPostal}`);
        }
        return;
    }

    await connectDB();
    const summary = await extractCAT(filePath);
    console.log(
        `[CAT] Importación completada: ${summary.provincias} provincias, ` +
        `${summary.localidades} localidades y ${summary.entidades} entidades.`
    );
};

if (require.main === module) {
    run()
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[CAT] Error durante la importación: ${message}`);
            process.exitCode = 1;
        })
        .finally(async () => {
            if (mongoose.connection.readyState !== 0) {
                await mongoose.disconnect();
            }
        });
}
