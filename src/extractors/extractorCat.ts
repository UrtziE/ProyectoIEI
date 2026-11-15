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
// --- Informe de la importación -------------------------------------------------
// El enunciado pide informar de los registros erróneos y de los reparados.
interface RegistroErroneo {
    indice: number;
    nombre?: string;
    motivo: string;
}

interface RegistroReparado {
    indice: number;
    nombre?: string;
    campo: string;
    original: string;
    reparado: string;
}

interface ImportReport {
    totalLeidos: number;
    insertadas: number;
    provincias: number;
    localidades: number;
    erroneos: RegistroErroneo[];
    reparados: RegistroReparado[];
}

const newInforme = (): Informe => ({ reparados: [], rechazados: [], duplicados: [] });

// ---------- Utilidades ----------
const crearInforme = (totalLeidos: number): ImportReport => ({
    totalLeidos,
    insertadas: 0,
    provincias: 0,
    localidades: 0,
    erroneos: [],
    reparados: []
});

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
// --- Reparaciones seguras ------------------------------------------------------

/**
 * Normaliza el código postal. Repara el caso típico de CP catalán al que le falta
 * el 0 inicial (4 dígitos). Devuelve un motivo de error si no es reparable con
 * seguridad (no queda en 5 dígitos) o si su provincia no es catalana (semántico).
 */
const normalizarCodigoPostal = (
    raw: string
): { cp: string; reparado: boolean } | { motivo: string } => {
    const original = raw.trim();
    let cp = original.replace(/\D/g, '');
    if (cp.length === 4) {
        cp = cp.padStart(5, '0');
    }

    if (!/^\d{5}$/.test(cp)) {
        return { motivo: `código postal no válido: "${original}"` };
    }
    if (!PROVINCE_BY_POSTAL_PREFIX[cp.slice(0, 2)]) {
        return { motivo: `código postal fuera de Catalunya: "${cp}"` };
    }

    return { cp, reparado: cp !== original };
};

/** tel_fon puede traer varios números pegados: se normalizan a un separador único. */
const normalizarTelefono = (raw: string): { value: string; reparado: boolean } => {
    const original = raw.trim();
    const numeros = original.split(/[\s,;/]+/).map((n) => n.trim()).filter(Boolean);
    const value = numeros.join(' / ');
    return { value, reparado: value !== original };
};

/** web sin protocolo -> se antepone http://. Si sigue sin pinta de URL, se descarta. */
const normalizarWeb = (raw: string): { value?: string; reparado: boolean } => {
    const original = raw.trim();
    let web = original;
    if (!/^https?:\/\//i.test(web)) {
        web = `http://${web}`;
    }
    try {
        const url = new URL(web);
        if (url.hostname.includes('.')) {
            return { value: web, reparado: web !== original };
        }
    } catch {
        // URL irrecuperable: se trata como ausente (campo opcional).
    }
    return { value: undefined, reparado: false };
};

/**
 * Valida y repara un registro. Devuelve el registro preparado o null si es erróneo.
 * Nunca lanza: los problemas se anotan en el informe (erroneos / reparados).
 */
const prepararRegistro = (
    record: CatRecord,
    indice: number,
    informe: ImportReport
): PreparedCatRecord | null => {
    const nombre = optionalValue(record.nombre);
    if (!nombre) {
        informe.erroneos.push({ indice, motivo: 'falta el nombre (nom_de_l_entitat)' });
        return null;
    }

    const municipio = optionalValue(record.municipio);
    if (!municipio) {
        informe.erroneos.push({ indice, nombre, motivo: 'falta el municipio (municipi)' });
        return null;
    }

    const direccion = optionalValue(record.direccion);
    if (!direccion) {
        informe.erroneos.push({ indice, nombre, motivo: 'falta la dirección (adre_a)' });
        return null;
    }

    const cpRaw = optionalValue(record.codigoPostal);
    if (!cpRaw) {
        informe.erroneos.push({ indice, nombre, motivo: 'falta el código postal (codi_postal)' });
        return null;
    }
    const cpRes = normalizarCodigoPostal(cpRaw);
    if ('motivo' in cpRes) {
        informe.erroneos.push({ indice, nombre, motivo: cpRes.motivo });
        return null;
    }
    const codigoPostal = cpRes.cp;
    if (cpRes.reparado) {
        informe.reparados.push({ indice, nombre, campo: 'codigo_postal', original: cpRaw, reparado: codigoPostal });
    }
    const provincia = PROVINCE_BY_POSTAL_PREFIX[codigoPostal.slice(0, 2)];

    // Contacto (opcional): teléfono (posiblemente múltiple) / móvil / email.
    const telRaw = optionalValue(record.telefono);
    let telefono: string | undefined;
    if (telRaw) {
        const tel = normalizarTelefono(telRaw);
        telefono = tel.value;
        if (tel.reparado) {
            informe.reparados.push({ indice, nombre, campo: 'telefono', original: telRaw, reparado: tel.value });
        }
    }
    const movil = optionalValue(record.movil);
    const email = optionalValue(record.email);
    const contacto = [
        telefono ? `Teléfono: ${telefono}` : undefined,
        movil ? `Móvil: ${movil}` : undefined,
        email ? `Email: ${email}` : undefined
    ].filter(Boolean).join(' · ') || undefined;

    // Descripción (opcional): naturaleza + CIF (+ nº de registro).
    const descripcion = [
        record.numeroRegistro ? `Número de registro: ${record.numeroRegistro}` : undefined,
        record.naturaleza ? `Naturaleza: ${record.naturaleza}` : undefined,
        record.cif ? `CIF: ${record.cif}` : undefined
    ].filter(Boolean).join(' · ') || undefined;

    // URL (opcional).
    const webRaw = optionalValue(record.web);
    let url: string | undefined;
    if (webRaw) {
        const web = normalizarWeb(webRaw);
        url = web.value;
        if (web.reparado && web.value) {
            informe.reparados.push({ indice, nombre, campo: 'URL', original: webRaw, reparado: web.value });
        }
    }

    return { nombre, municipio, provincia, codigoPostal, direccion, url, contacto, descripcion, ambito: CAT_AMBITO };
};

/** Pide coordenadas al robot, con 1 reintento ante un fallo puntual de la web. */
const obtenerCoordenadas = async (
    direccionBusqueda: string
): Promise<{ latitud: number; longitud: number } | null> => {
    for (let intento = 1; intento <= 2; intento += 1) {
        const coords = await conseguirCoordenadasGPS(direccionBusqueda);
        const longitud = coords.longitud ? parseFloat(coords.longitud) : NaN;
        const latitud = coords.latitud ? parseFloat(coords.latitud) : NaN;
        if (!Number.isNaN(longitud) && !Number.isNaN(latitud)) {
            return { latitud, longitud };
        }
    }
    return null;
};

export const extractCAT = async (filePath = DEFAULT_CAT_FILE): Promise<ImportReport> => {
    const records = await readCatRecords(filePath);
    const informe = crearInforme(records.length);

    const vistos = new Set<string>();
    const provinciasVistas = new Set<string>();
    const localidadesVistas = new Set<string>();

    for (const [i, record] of records.entries()) {
        const indice = i + 1;

        const prep = prepararRegistro(record, indice, informe);
        if (!prep) {
            continue;
        }

        // Duplicados: misma entidad (nombre + municipio) ya procesada.
        const clave = `${prep.nombre}||${prep.municipio}`.toLowerCase();
        if (vistos.has(clave)) {
            informe.erroneos.push({ indice, nombre: prep.nombre, motivo: `duplicado de "${prep.nombre}" en ${prep.municipio}` });
            continue;
        }

        // Coordenadas (obligatorias en el esquema global): sin ellas -> erróneo.
        const direccionBusqueda = [prep.direccion, prep.municipio, prep.codigoPostal, 'España'].join(', ');
        const coordenadas = await obtenerCoordenadas(direccionBusqueda);
        if (!coordenadas) {
            informe.erroneos.push({ indice, nombre: prep.nombre, motivo: 'no se pudieron obtener coordenadas' });
            continue;
        }

        try {
            const provincia = await Provincia.findOneAndUpdate(
                { nombre: prep.provincia },
                { nombre: prep.provincia },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            ).exec();
            if (!provinciasVistas.has(prep.provincia)) {
                provinciasVistas.add(prep.provincia);
                informe.provincias += 1;
            }

            const localidad = await Localidad.findOneAndUpdate(
                { nombre: prep.municipio, provincia: provincia._id },
                { nombre: prep.municipio, provincia: provincia._id },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            ).exec();
            const claveLocalidad = `${prep.municipio}||${prep.provincia}`;
            if (!localidadesVistas.has(claveLocalidad)) {
                localidadesVistas.add(claveLocalidad);
                informe.localidades += 1;
            }

            const entidadData = {
                nombre: prep.nombre,
                ambito: prep.ambito,
                direccion: prep.direccion,
                codigo_postal: prep.codigoPostal,
                longitud: coordenadas.longitud,
                latitud: coordenadas.latitud,
                localidad: localidad._id,
                ...(prep.url ? { URL: prep.url } : {}),
                ...(prep.contacto ? { contacto: prep.contacto } : {}),
                ...(prep.descripcion ? { descripcion: prep.descripcion } : {})
            };

            await Entidad.findOneAndUpdate(
                { nombre: prep.nombre, localidad: localidad._id },
                entidadData,
                { upsert: true, new: true, setDefaultsOnInsert: true }
            ).exec();

            vistos.add(clave);
            informe.insertadas += 1;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            informe.erroneos.push({ indice, nombre: prep.nombre, motivo: `error al guardar: ${message}` });
        }
    }

    return informe;
};

// --- Salida por consola --------------------------------------------------------

const imprimirInforme = (informe: ImportReport, dryRun: boolean): void => {
    const cabecera = dryRun
        ? '[CAT] Dry-run (validación de campos, sin coordenadas ni BD)'
        : '[CAT] Importación completada';
    const etiquetaOk = dryRun ? 'válidos' : 'insertadas';
    console.log(
        `${cabecera}: ${informe.totalLeidos} leídos · ` +
        `${informe.insertadas} ${etiquetaOk} · ${informe.erroneos.length} erróneos · ` +
        `${informe.reparados.length} reparados`
    );
    if (!dryRun) {
        console.log(`[CAT]   ${informe.provincias} provincias · ${informe.localidades} localidades`);
    }

    if (informe.reparados.length > 0) {
        console.log('[CAT] Reparados:');
        for (const r of informe.reparados) {
            console.log(`  - #${r.indice} ${r.nombre ?? ''} | ${r.campo}: "${r.original}" -> "${r.reparado}"`);
        }
    }
    if (informe.erroneos.length > 0) {
        console.log('[CAT] Erróneos:');
        for (const e of informe.erroneos) {
            console.log(`  - #${e.indice} ${e.nombre ?? ''} | ${e.motivo}`);
        }
    }
};

/** Dry-run: aplica validación y reparación de campos sin scraper ni MongoDB. */
const validarEnSeco = (records: CatRecord[]): ImportReport => {
    const informe = crearInforme(records.length);
    const vistos = new Set<string>();

    records.forEach((record, i) => {
        const indice = i + 1;
        const prep = prepararRegistro(record, indice, informe);
        if (!prep) {
            return;
        }
        const clave = `${prep.nombre}||${prep.municipio}`.toLowerCase();
        if (vistos.has(clave)) {
            informe.erroneos.push({ indice, nombre: prep.nombre, motivo: `duplicado de "${prep.nombre}" en ${prep.municipio}` });
            return;
        }
        vistos.add(clave);
        informe.insertadas += 1; // en dry-run: registros que pasarían (pendiente de coordenadas)
    });

    return informe;
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
