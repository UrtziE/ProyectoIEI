import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { convertXML } from 'simple-xml-to-json';
import connectDB from '../config/database';
import Entidad, { Ambito } from '../models/Entidad';
import Localidad from '../models/Localidad';
import Provincia from '../models/Provincia';
import { conseguirCoordenadasGPS } from '../robot/seleniumScraper';
import { clasificarAmbitosConIA } from '../utils/clasificarAmbito';
import vaciarBaseDatos from '../utils/vaciarBaseDatos';
import { red } from '../utils/terminalOutput';
import { normalizarUrl } from '../utils/normalizarUrl';

const DEFAULT_CAT_FILE = path.resolve(process.cwd(), 'src/public/fuentes_de_datos/Cat.xml');

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

interface ConvertedCatDocument {
    registre_ongd?: {
        children?: Array<{ entitat?: { children?: ConvertedEntityField[] } }>;
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
    codigoPostal: string;
    direccion: string;
    url?: string;
    contacto?: string;
    descripcion?: string;
    ambito?: Ambito;
}

interface ExtractOptions {
    clearDatabase?: boolean;
}

interface Incidencia {
    registro: string;
    motivo: string;
}

export interface ImportSummary {
    provincias: number;
    localidades: number;
    entidades: number;
    reparados: Incidencia[];
    rechazados: Incidencia[];
    duplicados: Incidencia[];
}

const newSummary = (): ImportSummary => ({
    provincias: 0,
    localidades: 0,
    entidades: 0,
    reparados: [],
    rechazados: [],
    duplicados: []
});

const optionalValue = (value: string | undefined): string | undefined => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
};

const normalize = (value: string): string => value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');

/** Lee el XML y adapta los campos catalanes al formato interno del extractor. */
export const readCatRecords = async (filePath = DEFAULT_CAT_FILE): Promise<CatRecord[]> => {
    const xml = await fs.readFile(filePath, 'utf8');
    const converted = convertXML(xml) as ConvertedCatDocument;
    const entities = converted.registre_ongd?.children;

    if (!Array.isArray(entities) || entities.length === 0) {
        throw new Error(`El XML ${filePath} no contiene entidades en registre_ongd.`);
    }

    return entities.map((entry) => {
        const values: Record<string, string | undefined> = {};
        for (const field of entry.entitat?.children ?? []) {
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

const normalizePostalCode = (raw: string | undefined): { cp?: string; error?: string } => {
    const digits = (raw ?? '').replace(/\D/g, '');
    if (!digits) return { error: 'Código postal vacío' };

    // Cataluña usa CP que empiezan por 08, 17, 25 o 43; solo Barcelona admite
    // la reparación segura de un cero inicial ausente.
    const cp = digits.length === 4 ? `0${digits}` : digits;
    if (!/^\d{5}$/.test(cp)) return { error: `Código postal inválido: "${raw}"` };
    if (!PROVINCE_BY_POSTAL_PREFIX[cp.slice(0, 2)]) {
        return { error: `El código postal ${cp} no corresponde a una provincia catalana` };
    }
    return { cp };
};

const splitPhones = (value?: string): string[] =>
    (value ?? '').split(/[\/,;]/).map((phone) => phone.trim()).filter(Boolean);

const buildContacto = (record: CatRecord): string | undefined => {
    const telefonos = [...new Set(splitPhones(record.telefono))];
    const moviles = [...new Set(splitPhones(record.movil))].filter((movil) => !telefonos.includes(movil));
    const parts = [
        telefonos.length ? `Teléfono: ${telefonos.join(' / ')}` : undefined,
        moviles.length ? `Móvil: ${moviles.join(' / ')}` : undefined,
        optionalValue(record.email) ? `Email: ${optionalValue(record.email)}` : undefined
    ].filter((part): part is string => Boolean(part));
    return parts.length ? parts.join(' · ') : undefined;
};

const buildDescripcion = (record: CatRecord): string | undefined => {
    const parts = [
        optionalValue(record.numeroRegistro) ? `Número de registro: ${optionalValue(record.numeroRegistro)}` : undefined,
        optionalValue(record.naturaleza) ? `Naturaleza: ${optionalValue(record.naturaleza)}` : undefined,
        optionalValue(record.cif) ? `CIF: ${optionalValue(record.cif)}` : undefined
    ].filter((part): part is string => Boolean(part));
    return parts.length ? parts.join(' · ') : undefined;
};

const AMBITO_KEYWORDS: Array<[Ambito, string[]]> = [
    ['MAYORES', ['gentgran', 'mayores', 'ancians', 'terceraedad']],
    ['DISCAPACIDAD', ['discapacitat', 'discapacidad', 'minusval', 'sindromededown', 'autis']],
    ['SALUD_MENTAL', ['salutmental', 'saludmental', 'psiquiat']],
    ['INFANCIA_Y_JUVENTUD', ['infan', 'jove', 'juvent', 'nens', 'menors', 'esplai']],
    ['MUJER', ['dones', 'mujer', 'muller', 'feminis']],
    ['MIGRACION', ['migra', 'refugi', 'immigra', 'inmigra']],
    ['EDUCACION_Y_FORMACION', ['educaci', 'formaci', 'escola', 'escuela']],
    ['EMPLEO_E_INSERCION_LABORAL', ['ocupaci', 'empleo', 'inserci', 'laboral']],
    ['SALUD_Y_ATENCION_SOCIOSANITARIA', ['sanit', 'salut', 'salud', 'cruzroja', 'creuroja']],
    ['VOLUNTARIADO_Y_PARTICIPACION_COMUNITARIA', ['voluntari', 'comunitari']],
    ['CULTURA_Y_DESARROLLO_COMUNITARIO', ['cultur', 'desenvolupament', 'desarrollo']]
];

const getAmbito = (nombre: string): Ambito | undefined => {
    const text = normalize(nombre);
    for (const [ambito, keywords] of AMBITO_KEYWORDS) {
        if (keywords.some((keyword) => text.includes(keyword))) return ambito;
    }
    return undefined;
};

/** Prepara y valida registros sin consultar MongoDB ni iniciar el navegador. */
const prepareRecords = (records: CatRecord[], summary: ImportSummary): PreparedCatRecord[] => {
    const prepared: PreparedCatRecord[] = [];
    const seenRegistration = new Set<string>();
    const seenNameAndTown = new Set<string>();

    records.forEach((record, index) => {
        const nombre = optionalValue(record.nombre);
        const municipio = optionalValue(record.municipio);
        const label = nombre ?? optionalValue(record.numeroRegistro) ?? `registro ${index + 1}`;
        const reject = (motivo: string): void => {
            summary.rechazados.push({ registro: label, motivo });
        };

        if (!nombre) return reject('Sin nombre de entidad');
        if (!municipio) return reject('Sin municipio');
        const direccion = optionalValue(record.direccion);
        if (!direccion) return reject('Sin dirección (obligatoria en el esquema global)');

        const postal = normalizePostalCode(record.codigoPostal);
        if (!postal.cp) return reject(postal.error ?? 'Código postal inválido');
        const originalCP = optionalValue(record.codigoPostal) ?? '';
        if (postal.cp !== originalCP.replace(/\D/g, '')) {
            summary.reparados.push({ registro: label, motivo: `Código postal "${originalCP}" corregido a "${postal.cp}"` });
        }

        const registration = optionalValue(record.numeroRegistro);
        const registrationKey = registration ? normalize(registration) : undefined;
        const entityKey = `${normalize(nombre)}|${normalize(municipio)}`;
        if ((registrationKey && seenRegistration.has(registrationKey)) || seenNameAndTown.has(entityKey)) {
            summary.duplicados.push({ registro: label, motivo: 'Registro duplicado dentro del fichero' });
            return;
        }
        if (registrationKey) seenRegistration.add(registrationKey);
        seenNameAndTown.add(entityKey);

        prepared.push({
            nombre,
            municipio,
            provincia: PROVINCE_BY_POSTAL_PREFIX[postal.cp.slice(0, 2)],
            codigoPostal: postal.cp,
            direccion,
            url: normalizarUrl(record.web),
            contacto: buildContacto(record),
            descripcion: buildDescripcion(record),
            ambito: getAmbito(nombre)
        });
    });
    return prepared;
};

interface Coordenadas {
    latitud: number;
    longitud: number;
}

const getCoordinates = async (record: PreparedCatRecord): Promise<Coordenadas | undefined> => {
    const address = `${record.direccion}, ${record.codigoPostal} ${record.municipio}, ${record.provincia}, España`;
    try {
        const result = await conseguirCoordenadasGPS(address);
        const latitud = Number(result.latitud);
        const longitud = Number(result.longitud);
        if (!result.latitud || !result.longitud || !Number.isFinite(latitud) || !Number.isFinite(longitud)) {
            return undefined;
        }
        if (latitud < -90 || latitud > 90 || longitud < -180 || longitud > 180) return undefined;
        return { latitud, longitud };
    } catch {
        return undefined;
    }
};

const ensureProvincia = async (nombre: string, summary: ImportSummary): Promise<mongoose.Types.ObjectId> => {
    const existing = await Provincia.findOne({ nombre }).exec();
    if (existing) return existing._id;
    const created = await Provincia.create({ nombre });
    summary.provincias += 1;
    return created._id;
};

const ensureLocalidad = async (
    nombre: string,
    provincia: mongoose.Types.ObjectId,
    summary: ImportSummary
): Promise<mongoose.Types.ObjectId> => {
    const existing = await Localidad.findOne({ nombre, provincia }).exec();
    if (existing) return existing._id;
    const created = await Localidad.create({ nombre, provincia });
    summary.localidades += 1;
    return created._id;
};

/** Importa entidades válidas; cada registro falla de forma aislada. */
export const extractCAT = async (
    filePath = DEFAULT_CAT_FILE,
    options: ExtractOptions = {}
): Promise<ImportSummary> => {
    const summary = newSummary();
    const records = prepareRecords(await readCatRecords(filePath), summary);
    if (options.clearDatabase !== false) await vaciarBaseDatos();
    console.log(`[CAT] ${records.length} registros válidos preparados. Clasificando ámbitos...`);
    const ambitosIA = await clasificarAmbitosConIA(records.map(({ nombre, descripcion }) => ({ nombre, descripcion })));
    console.log('[CAT] Clasificación terminada. Geocodificando e importando entidades...');
    records.forEach((record, index) => {
        record.ambito = ambitosIA[index] ?? record.ambito;
    });

    const recordsConAmbito = records.filter((record): record is PreparedCatRecord & { ambito: Ambito } => {
        if (record.ambito) return true;
        summary.rechazados.push({
            registro: record.nombre,
            motivo: 'No se pudo determinar un ámbito válido'
        });
        return false;
    });

    for (const [index, record] of recordsConAmbito.entries()) {
        try {
            console.log(`[CAT] Consultando ubicación ${index + 1}/${recordsConAmbito.length}: ${record.nombre}`);
            const provinciaExistente = await Provincia.findOne({ nombre: record.provincia }).exec();
            const localidadExistente = provinciaExistente
                ? await Localidad.findOne({ nombre: record.municipio, provincia: provinciaExistente._id }).exec()
                : null;
            if (localidadExistente && await Entidad.exists({ nombre: record.nombre, localidad: localidadExistente._id })) {
                summary.duplicados.push({ registro: record.nombre, motivo: 'Ya existe en la base de datos' });
                continue;
            }

            const coords = await getCoordinates(record);
            if (!coords) {
                summary.rechazados.push({ registro: record.nombre, motivo: 'No se pudieron obtener coordenadas válidas' });
                continue;
            }

            const provinciaId = provinciaExistente?._id ?? await ensureProvincia(record.provincia, summary);
            const localidadId = localidadExistente?._id ?? await ensureLocalidad(record.municipio, provinciaId, summary);
            await Entidad.create({
                nombre: record.nombre,
                ambito: record.ambito,
                direccion: record.direccion,
                codigo_postal: record.codigoPostal,
                latitud: coords.latitud,
                longitud: coords.longitud,
                localidad: localidadId,
                ...(record.url ? { URL: record.url } : {}),
                ...(record.contacto ? { contacto: record.contacto } : {}),
                ...(record.descripcion ? { descripcion: record.descripcion } : {})
            });
            summary.entidades += 1;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            summary.rechazados.push({ registro: record.nombre, motivo: `Error al guardar: ${message}` });
        }
    }

    return summary;
};

const printIncidencias = (label: string, incidencias: Incidencia[]): void => {
    incidencias.slice(0, 20).forEach(({ registro, motivo }) => {
        console.log(red(`[CAT] ${label} - ${registro}: ${motivo}`));
    });
    if (incidencias.length > 20) console.log(`[CAT] ${label}: ... y ${incidencias.length - 20} más`);
};

const run = async (): Promise<void> => {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const filePathArgument = args.find((argument) => argument !== '--dry-run');
    const filePath = filePathArgument ? path.resolve(process.cwd(), filePathArgument) : DEFAULT_CAT_FILE;

    if (dryRun) {
        const summary = newSummary();
        const prepared = prepareRecords(await readCatRecords(filePath), summary);
        console.log(
            `[CAT] Validación: ${prepared.length} entidades preparadas, ${summary.reparados.length} reparadas, ` +
            `${summary.rechazados.length} rechazadas y ${summary.duplicados.length} duplicadas. ` +
            'No se ha conectado a MongoDB ni se ha iniciado Selenium.'
        );
        printIncidencias('Reparado', summary.reparados);
        printIncidencias('Rechazado', summary.rechazados);
        printIncidencias('Duplicado', summary.duplicados);
        return;
    }

    console.log(`[CAT] Conectando a MongoDB y preparando ${filePath}...`);
    await connectDB();
    const summary = await extractCAT(filePath);
    console.log(
        `[CAT] Importación completada: ${summary.entidades} entidades, ${summary.provincias} provincias nuevas y ` +
        `${summary.localidades} localidades nuevas.`
    );
    console.log(
        `[CAT] Reparados: ${summary.reparados.length}, rechazados: ${summary.rechazados.length}, ` +
        `duplicados: ${summary.duplicados.length}.`
    );
    printIncidencias('Reparado', summary.reparados);
    printIncidencias('Rechazado', summary.rechazados);
    printIncidencias('Duplicado', summary.duplicados);
};

if (require.main === module) {
    run()
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[CAT] Error durante la importación: ${message}`);
            process.exitCode = 1;
        })
        .finally(async () => {
            if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
        });
}
