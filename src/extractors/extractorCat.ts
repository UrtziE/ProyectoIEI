import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { convertXML } from 'simple-xml-to-json';
import connectDB from '../config/database';
import Entidad, { Ambito } from '../models/Entidad';
import Localidad from '../models/Localidad';
import Provincia from '../models/Provincia';
import { conseguirCoordenadasGPS } from '../robot/seleniumScraper';

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
    codigoPostal: string;
    direccion: string;
    url?: string;
    contacto?: string;
    descripcion?: string;
    ambito: Ambito;
}

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

const run = async (): Promise<void> => {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const filePathArgument = args.find((argument) => argument !== '--dry-run');
    const filePath = filePathArgument
        ? path.resolve(process.cwd(), filePathArgument)
        : DEFAULT_CAT_FILE;

    if (dryRun) {
        const informe = validarEnSeco(await readCatRecords(filePath));
        imprimirInforme(informe, true);
        return;
    }

    await connectDB();
    const informe = await extractCAT(filePath);
    imprimirInforme(informe, false);
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
