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

const DEFAULT_CAT_FILE = path.resolve(process.cwd(), 'src/public/fuentes_de_datos/Cat.xml');

const PROVINCE_BY_POSTAL_PREFIX: Record<string, string> = {
    '08': 'Barcelona',
    '17': 'Girona',
    '25': 'Lleida',
    '43': 'Tarragona'
};

// ---------- Tipos ----------

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
    codigoPostal: string;
    direccion: string;
    url?: string;
    contacto?: string;
    descripcion?: string;
    ambito: Ambito;
}

interface Incidencia {
    registro: string;
    motivo: string;
}

interface Informe {
    reparados: Incidencia[];  // el dato venía mal y se ha corregido
    rechazados: Incidencia[]; // no se puede guardar
    duplicados: Incidencia[]; // ya estaba repetido o ya existía
}

export interface ImportSummary extends Informe {
    provincias: number;
    localidades: number;
    entidades: number;
}

const newInforme = (): Informe => ({ reparados: [], rechazados: [], duplicados: [] });

// ---------- Utilidades ----------

const optionalValue = (value: string | undefined): string | undefined => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized ? normalized : undefined;
};

// Texto sin acentos, minúsculas, sin espacios ni símbolos (sirve para comparar y para claves)
const normalize = (value: string): string =>
    value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

// ---------- Lectura del XML ----------

/**
 * Convierte el XML con simple-xml-to-json y adapta la estructura children/content
 * que genera la librería a registros planos para que el extractor pueda usarlos.
 * Solo lanza error si el fichero entero es inválido; un registro mal formado
 * se devuelve vacío y se rechaza después, sin parar la carga.
 */
export const readCatRecords = async (filePath = DEFAULT_CAT_FILE): Promise<CatRecord[]> => {
    const xml = await fs.readFile(filePath, 'utf8');
    const converted = convertXML(xml) as ConvertedCatDocument;
    const entities = converted.registre_ongd?.children;

    if (!Array.isArray(entities) || entities.length === 0) {
        throw new Error(`El XML ${filePath} no contiene entidades en registre_ongd.`);
    }

    return entities.map((entry) => {
        const fields = entry.entitat?.children;
        if (!Array.isArray(fields)) {
            return {};
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

// ---------- Transformaciones del mapping ----------

// Valida el CP y lo repara si se puede (p. ej. "8017" -> "08017", "08 017" -> "08017")
const normalizePostalCode = (raw: string | undefined): { cp?: string; error?: string } => {
    const digits = (raw ?? '').replace(/\D/g, '');

    if (!digits) {
        return { error: 'Código postal vacío' };
    }
    if (digits.length === 4) {
        return { cp: `0${digits}` };
    }
    if (digits.length !== 5) {
        return { error: `Código postal inválido: "${raw}"` };
    }

    return { cp: digits };
};

const provinceFromPostalCode = (cp: string): string | undefined =>
    PROVINCE_BY_POSTAL_PREFIX[cp.slice(0, 2)];

// Un campo de teléfono puede traer varios números separados por / , ;
const splitPhones = (value?: string): string[] =>
    (value ?? '').split(/[\/,;]/).map((phone) => phone.trim()).filter(Boolean);

const buildContacto = (record: CatRecord): string | undefined => {
    const telefonos = [...new Set(splitPhones(record.telefono))];
    const moviles = [...new Set(splitPhones(record.movil))].filter((movil) => !telefonos.includes(movil));

    const parts = [
        telefonos.length ? `Teléfono: ${telefonos.join(' / ')}` : undefined,
        moviles.length ? `Móvil: ${moviles.join(' / ')}` : undefined,
        record.email ? `Email: ${record.email}` : undefined
    ].filter(Boolean);

    return parts.length ? parts.join(' · ') : undefined;
};

const buildDescripcion = (record: CatRecord): string | undefined => {
    const parts = [
        record.numeroRegistro ? `Número de registro: ${record.numeroRegistro}` : undefined,
        record.naturaleza ? `Naturaleza: ${record.naturaleza}` : undefined,
        record.cif ? `CIF: ${record.cif}` : undefined
    ].filter(Boolean);

    return parts.length ? parts.join(' · ') : undefined;
};

// Palabras clave sin acentos ni espacios: en el XML los nombres vienen sin espacios.
// Sustituir por la llamada a IA cuando esté lista.
const AMBITO_KEYWORDS: Array<[Ambito, string[]]> = [
    ['MAYORES', ['gentgran', 'mayores', 'ancians', 'terceraedad']],
    ['DISCAPACIDAD', ['discapacit', 'minusval', 'sindromededown', 'autis']],
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

const getAmbito = (nombre: string): Ambito => {
    const text = normalize(nombre);

    for (const [ambito, keywords] of AMBITO_KEYWORDS) {
        if (keywords.some((keyword) => text.includes(keyword))) {
            return ambito;
        }
    }

    return 'SIN_CLASIFICAR';
};

// ---------- Fase 1: validar y preparar (sin MongoDB ni robot) ----------

/**
 * Nunca lanza errores por un registro malo: lo anota en el informe y sigue con el siguiente.
 */
const prepareRecords = (records: CatRecord[], informe: Informe): PreparedCatRecord[] => {
    const prepared: PreparedCatRecord[] = [];
    const seenRegistro = new Set<string>();
    const seenNombre = new Set<string>();

    records.forEach((record, index) => {
        const nombre = optionalValue(record.nombre);
        const municipio = optionalValue(record.municipio);
        const id = nombre ?? record.numeroRegistro ?? `registro ${index + 1}`;

        if (!nombre) {
            informe.rechazados.push({ registro: id, motivo: 'Sin nombre de entidad' });
            return;
        }
        if (!municipio) {
            informe.rechazados.push({ registro: id, motivo: 'Sin municipio' });
            return;
        }

        const direccion = optionalValue(record.direccion);
        if (!direccion) {
            informe.rechazados.push({ registro: id, motivo: 'Sin dirección (obligatoria en el esquema global)' });
            return;
        }

        const postal = normalizePostalCode(record.codigoPostal);
        if (!postal.cp) {
            informe.rechazados.push({ registro: id, motivo: postal.error ?? 'Código postal inválido' });
            return;
        }
        const provincia = provinceFromPostalCode(postal.cp);
        if (!provincia) {
            informe.rechazados.push({
                registro: id,
                motivo: `El código postal ${postal.cp} no corresponde a una provincia catalana`
            });
            return;
        }

        // Duplicados dentro del propio fichero
        const nombreKey = `${normalize(nombre)}|${normalize(municipio)}`;
        if (record.numeroRegistro && seenRegistro.has(record.numeroRegistro)) {
            informe.duplicados.push({
                registro: id,
                motivo: `Número de registro ${record.numeroRegistro} repetido en el fichero`
            });
            return;
        }
        if (seenNombre.has(nombreKey)) {
            informe.duplicados.push({ registro: id, motivo: 'Misma entidad y municipio repetidos en el fichero' });
            return;
        }
        if (record.numeroRegistro) {
            seenRegistro.add(record.numeroRegistro);
        }
        seenNombre.add(nombreKey);

        // La reparación solo se anota si el registro sigue adelante (si se rechaza, no consta como reparado)
        if (postal.cp !== record.codigoPostal) {
            informe.reparados.push({
                registro: id,
                motivo: `Código postal "${record.codigoPostal}" corregido a "${postal.cp}"`
            });
        }

        prepared.push({
            nombre,
            municipio,
            provincia,
            codigoPostal: postal.cp,
            direccion,
            url: optionalValue(record.web),
            contacto: buildContacto(record),
            descripcion: buildDescripcion(record),
            ambito: getAmbito(nombre)
        });
    });

    return prepared;
};

// ---------- Coordenadas (robot de Selenium) ----------

interface Coordenadas {
    latitud: number;
    longitud: number;
}

const getCoordinates = async (record: PreparedCatRecord): Promise<Coordenadas | undefined> => {
    const address = `${record.direccion}, ${record.codigoPostal} ${record.municipio}, ${record.provincia}`;

    try {
        const result = await conseguirCoordenadasGPS(address);
        const latitud = Number(result.latitud);
        const longitud = Number(result.longitud);

        // El robot devuelve cadenas vacías cuando no encuentra la dirección
        if (!result.latitud || !result.longitud || !Number.isFinite(latitud) || !Number.isFinite(longitud)) {
            return undefined;
        }

        return { latitud, longitud };
    } catch {
        return undefined;
    }
};

// ---------- Provincias y localidades (con caché y contadores correctos) ----------

const createResolvers = (summary: ImportSummary) => {
    // Las cachés viven dentro de la función: si se vacía la base de datos entre dos cargas, no quedan ids antiguos.
    const provincias = new Map<string, mongoose.Types.ObjectId>();
    const localidades = new Map<string, mongoose.Types.ObjectId>();

    const localidadKey = (provinciaId: mongoose.Types.ObjectId, municipio: string): string =>
        `${provinciaId}|${municipio}`;

    // find: solo busca, no crea nada
    const findProvinciaId = async (nombre: string): Promise<mongoose.Types.ObjectId | undefined> => {
        const cached = provincias.get(nombre);
        if (cached) {
            return cached;
        }

        const doc = await Provincia.findOne({ nombre }).exec();
        if (!doc) {
            return undefined;
        }

        provincias.set(nombre, doc._id);
        return doc._id;
    };

    const findLocalidadId = async (
        provinciaId: mongoose.Types.ObjectId,
        municipio: string
    ): Promise<mongoose.Types.ObjectId | undefined> => {
        const key = localidadKey(provinciaId, municipio);
        const cached = localidades.get(key);
        if (cached) {
            return cached;
        }

        const doc = await Localidad.findOne({ nombre: municipio, provincia: provinciaId }).exec();
        if (!doc) {
            return undefined;
        }

        localidades.set(key, doc._id);
        return doc._id;
    };

    // ensure: busca y, si no existe, la crea y SOLO entonces suma al contador
    const ensureProvinciaId = async (nombre: string): Promise<mongoose.Types.ObjectId> => {
        const existing = await findProvinciaId(nombre);
        if (existing) {
            return existing;
        }

        const doc = await Provincia.create({ nombre });
        summary.provincias += 1;
        provincias.set(nombre, doc._id);
        return doc._id;
    };

    const ensureLocalidadId = async (
        provinciaId: mongoose.Types.ObjectId,
        municipio: string
    ): Promise<mongoose.Types.ObjectId> => {
        const existing = await findLocalidadId(provinciaId, municipio);
        if (existing) {
            return existing;
        }

        const doc = await Localidad.create({ nombre: municipio, provincia: provinciaId });
        summary.localidades += 1;
        localidades.set(localidadKey(provinciaId, municipio), doc._id);
        return doc._id;
    };

    return { findProvinciaId, findLocalidadId, ensureProvinciaId, ensureLocalidadId };
};

// ---------- Fase 2: guardar en MongoDB ----------

export const extractCAT = async (filePath = DEFAULT_CAT_FILE): Promise<ImportSummary> => {
    const summary: ImportSummary = { provincias: 0, localidades: 0, entidades: 0, ...newInforme() };

    // Primero se valida todo el XML; los registros erróneos quedan en el informe y no paran la carga.
    const records = prepareRecords(await readCatRecords(filePath), summary);

    // Ámbito con IA (Gemini), por lotes. Si la IA no está disponible o falla,
    // se mantiene el ámbito calculado con palabras clave en prepareRecords.
    const ambitosIA = await clasificarAmbitosConIA(records.map((record) => ({ nombre: record.nombre })));
    records.forEach((record, index) => {
        record.ambito = ambitosIA[index] ?? record.ambito;
    });
    console.log(
        `[CAT] Ámbito: ${ambitosIA.filter(Boolean).length} clasificados por IA, ` +
        `${ambitosIA.filter((ambito) => !ambito).length} por palabras clave.`
    );

    const resolvers = createResolvers(summary);

    for (const record of records) {
        try {
            // 1) ¿Ya existe en el almacén de datos? Solo se consulta, sin crear provincia ni localidad todavía.
            const provinciaExistente = await resolvers.findProvinciaId(record.provincia);
            const localidadExistente = provinciaExistente
                ? await resolvers.findLocalidadId(provinciaExistente, record.municipio)
                : undefined;

            if (localidadExistente && await Entidad.exists({ nombre: record.nombre, localidad: localidadExistente })) {
                summary.duplicados.push({ registro: record.nombre, motivo: 'Ya existe en el almacén de datos' });
                continue;
            }

            // 2) Coordenadas con el robot. Se hace al final (es lo más lento) y son obligatorias en Entidad.
            const coords = await getCoordinates(record);
            if (!coords) {
                summary.rechazados.push({
                    registro: record.nombre,
                    motivo: `No se pudieron obtener las coordenadas de "${record.direccion}"`
                });
                continue;
            }

            // 3) Crear provincia y localidad si faltan (el contador solo sube al crearlas)
            const provinciaId = await resolvers.ensureProvinciaId(record.provincia);
            const localidadId = await resolvers.ensureLocalidadId(provinciaId, record.municipio);

            // 4) Guardar la entidad
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
    incidencias.slice(0, 20).forEach((item) => console.log(`[CAT] ${label} - ${item.registro}: ${item.motivo}`));
    if (incidencias.length > 20) {
        console.log(`[CAT] ${label}: ... y ${incidencias.length - 20} más`);
    }
};

const run = async (): Promise<void> => {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const filePathArgument = args.find((argument) => argument !== '--dry-run');
    const filePath = filePathArgument
        ? path.resolve(process.cwd(), filePathArgument)
        : DEFAULT_CAT_FILE;

    if (dryRun) {
        const informe = newInforme();
        const records = prepareRecords(await readCatRecords(filePath), informe);
        console.log(
            `[CAT] Validación: ${records.length} entidades preparadas, ${informe.reparados.length} reparadas, ` +
            `${informe.rechazados.length} rechazadas y ${informe.duplicados.length} duplicadas. ` +
            'No se ha conectado a MongoDB ni se ha lanzado el robot.'
        );
        printIncidencias('Reparado', informe.reparados);
        printIncidencias('Rechazado', informe.rechazados);
        printIncidencias('Duplicado', informe.duplicados);
        return;
    }

    await connectDB();
    const summary = await extractCAT(filePath);
    console.log(
        `[CAT] Importación completada: ${summary.provincias} provincias nuevas, ` +
        `${summary.localidades} localidades nuevas y ${summary.entidades} entidades nuevas.`
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
            if (mongoose.connection.readyState !== 0) {
                await mongoose.disconnect();
            }
        });
}
