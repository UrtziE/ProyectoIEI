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
import { green, orange, red } from '../utils/terminalOutput';
import { normalizarUrl } from '../utils/normalizarUrl';
import { normalizarDireccion, separarPalabrasPegadas } from '../utils/normalizarDireccion';

const DEFAULT_CAT_FILE = path.resolve(process.cwd(), 'src/public/fuentes_de_datos/Entitats_ONGD_pretty.xml');

const PROVINCIA_POR_PREFIJO_POSTAL: Record<string, string> = {
    '08': 'Barcelona',
    '17': 'Girona',
    '25': 'Lleida',
    '43': 'Tarragona'
};

interface CampoConvertido {
    content?: string;
}

type CampoEntidadConvertido = Record<string, CampoConvertido>;

interface DocumentoCatConvertido {
    registre_ongd?: {
        children?: Array<{ entitat?: { children?: CampoEntidadConvertido[] } }>;
    };
}

interface RegistroCat {
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

interface RegistroCatPreparado {
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

interface Incidencia {
    registro: string;
    motivo: string;
}

export interface ResumenImportacionCat {
    provincias: number;
    localidades: number;
    entidades: number;
    reparados: Incidencia[];
    rechazados: Incidencia[];
    duplicados: Incidencia[];
}

const crearResumen = (): ResumenImportacionCat => ({
    provincias: 0,
    localidades: 0,
    entidades: 0,
    reparados: [],
    rechazados: [],
    duplicados: []
});

const obtenerValorOpcional = (value: string | undefined): string | undefined => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
};

const normalizarTextoCatalan = (value: string | undefined): string | undefined => {
    const normalized = obtenerValorOpcional(value);
    return normalized ? separarPalabrasPegadas(normalized) : undefined;
};

const normalizarClave = (value: string): string => value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');

/** Lee el XML y adapta los campos catalanes al formato interno del extractor. */
export const leerRegistrosCat = async (filePath = DEFAULT_CAT_FILE): Promise<RegistroCat[]> => {
    const xml = await fs.readFile(filePath, 'utf8');
    const documentoConvertido = convertXML(xml) as DocumentoCatConvertido;
    const entidades = documentoConvertido.registre_ongd?.children;

    if (!Array.isArray(entidades) || entidades.length === 0) {
        throw new Error(`El XML ${filePath} no contiene entidades en registre_ongd.`);
    }

    return entidades.map((entry) => {
        const values: Record<string, string | undefined> = {};
        for (const field of entry.entitat?.children ?? []) {
            for (const [name, data] of Object.entries(field)) {
                values[name] = obtenerValorOpcional(data?.content);
            }
        }

        return {
            numeroRegistro: values.n_mero_registre,
            nombre: normalizarTextoCatalan(values.nom_de_l_entitat),
            naturaleza: normalizarTextoCatalan(values.naturalesa),
            cif: values.cif_entitat,
            direccion: normalizarTextoCatalan(values.adre_a),
            codigoPostal: values.codi_postal,
            municipio: normalizarTextoCatalan(values.municipi),
            telefono: values.tel_fon,
            movil: values.tel_fon_m_bil,
            email: values.correu_electr_nic,
            web: values.web
        };
    });
};

const normalizarCodigoPostal = (raw: string | undefined): { cp?: string; error?: string } => {
    const digits = (raw ?? '').replace(/\D/g, '');
    if (!digits) return { error: 'Código postal vacío' };

    // Cataluña usa CP que empiezan por 08, 17, 25 o 43; solo Barcelona admite
    // la reparación segura de un cero inicial ausente.
    const cp = digits.length === 4 ? `0${digits}` : digits;
    if (!/^\d{5}$/.test(cp)) return { error: `Código postal inválido: "${raw}"` };
    if (!PROVINCIA_POR_PREFIJO_POSTAL[cp.slice(0, 2)]) {
        return { error: `El código postal ${cp} no corresponde a una provincia catalana` };
    }
    return { cp };
};

const separarTelefonos = (value?: string): string[] =>
    (value ?? '').split(/[\/,;]/).map((phone) => phone.trim()).filter(Boolean);

const construirContacto = (registro: RegistroCat): string | undefined => {
    const telefonos = [...new Set(separarTelefonos(registro.telefono))];
    const moviles = [...new Set(separarTelefonos(registro.movil))].filter((movil) => !telefonos.includes(movil));
    const parts = [
        telefonos.length ? `Teléfono: ${telefonos.join(' / ')}` : undefined,
        moviles.length ? `Móvil: ${moviles.join(' / ')}` : undefined,
        obtenerValorOpcional(registro.email) ? `Email: ${obtenerValorOpcional(registro.email)}` : undefined
    ].filter((part): part is string => Boolean(part));
    return parts.length ? parts.join(' · ') : undefined;
};

const construirDescripcion = (registro: RegistroCat): string | undefined => {
    const parts = [
        obtenerValorOpcional(registro.numeroRegistro) ? `Número de registro: ${obtenerValorOpcional(registro.numeroRegistro)}` : undefined,
        obtenerValorOpcional(registro.naturaleza) ? `Naturaleza: ${obtenerValorOpcional(registro.naturaleza)}` : undefined,
        obtenerValorOpcional(registro.cif) ? `CIF: ${obtenerValorOpcional(registro.cif)}` : undefined
    ].filter((part): part is string => Boolean(part));
    return parts.length ? parts.join(' · ') : undefined;
};

const PALABRAS_CLAVE_AMBITO: Array<[Ambito, string[]]> = [
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

const obtenerAmbito = (nombre: string): Ambito | undefined => {
    const text = normalizarClave(nombre);
    for (const [ambito, keywords] of PALABRAS_CLAVE_AMBITO) {
        if (keywords.some((keyword) => text.includes(keyword))) return ambito;
    }
    return undefined;
};

/** Prepara y valida registros sin consultar MongoDB ni iniciar el navegador. */
const prepararRegistros = (records: RegistroCat[], summary: ResumenImportacionCat): RegistroCatPreparado[] => {
    const prepared: RegistroCatPreparado[] = [];
    const seenRegistration = new Set<string>();
    const seenNameAndTown = new Set<string>();

    records.forEach((record, index) => {
        const nombre = obtenerValorOpcional(record.nombre);
        const municipio = obtenerValorOpcional(record.municipio);
        const label = nombre ?? obtenerValorOpcional(record.numeroRegistro) ?? `registro ${index + 1}`;
        const reject = (motivo: string): void => {
            summary.rechazados.push({ registro: label, motivo });
            console.warn(red(`[CAT] Rechazado - ${label}: ${motivo}`));
        };

        if (!nombre) return reject('Sin nombre de entidad');
        if (!municipio) return reject('Sin municipio');
        const direccion = obtenerValorOpcional(record.direccion);
        if (!direccion) return reject('Sin dirección (obligatoria en el esquema global)');

        const postal = normalizarCodigoPostal(record.codigoPostal);
        if (!postal.cp) return reject(postal.error ?? 'Código postal inválido');
        const originalCP = obtenerValorOpcional(record.codigoPostal) ?? '';
        if (postal.cp !== originalCP.replace(/\D/g, '')) {
            summary.reparados.push({ registro: label, motivo: `Código postal "${originalCP}" corregido a "${postal.cp}"` });
        }

        const registration = obtenerValorOpcional(record.numeroRegistro);
        const registrationKey = registration ? normalizarClave(registration) : undefined;
        const entityKey = `${normalizarClave(nombre)}|${normalizarClave(municipio)}`;
        if ((registrationKey && seenRegistration.has(registrationKey)) || seenNameAndTown.has(entityKey)) {
            summary.duplicados.push({ registro: label, motivo: 'Registro duplicado dentro del fichero' });
            console.warn(red(`[CAT] Duplicado - ${label}: Registro duplicado dentro del fichero`));
            return;
        }
        if (registrationKey) seenRegistration.add(registrationKey);
        seenNameAndTown.add(entityKey);

        prepared.push({
            nombre,
            municipio,
            provincia: PROVINCIA_POR_PREFIJO_POSTAL[postal.cp.slice(0, 2)],
            codigoPostal: postal.cp,
            direccion,
            url: normalizarUrl(record.web),
            contacto: construirContacto(record),
            descripcion: construirDescripcion(record),
            ambito: obtenerAmbito(nombre)
        });
    });
    return prepared;
};

interface Coordenadas {
    latitud: number;
    longitud: number;
}

const obtenerCoordenadas = async (record: RegistroCatPreparado): Promise<Coordenadas | undefined> => {
    const direccionNormalizada = normalizarDireccion(record.direccion);
    if (direccionNormalizada !== record.direccion) {
        console.log(orange(
            `[CAT] Dirección adaptada para la búsqueda: "${record.direccion}" -> "${direccionNormalizada}"`
        ));
    }
    const municipioNormalizado = normalizarDireccion(record.municipio);
    const provinciaNormalizada = normalizarDireccion(record.provincia);
    const ubicacion = normalizarClave(municipioNormalizado) === normalizarClave(provinciaNormalizada)
        ? municipioNormalizado
        : `${municipioNormalizado}, ${provinciaNormalizada}`;
    const address = `${direccionNormalizada}, ${record.codigoPostal} ${ubicacion}, España`;
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

interface ResultadoGuardadoCat {
    provinciaNueva: boolean;
    localidadNueva: boolean;
}

const guardarEntidadCat = async (
    record: RegistroCatPreparado & { ambito: Ambito },
    coordenadas: Coordenadas
): Promise<ResultadoGuardadoCat> => {
    let idProvinciaNueva: mongoose.Types.ObjectId | undefined;
    let idLocalidadNueva: mongoose.Types.ObjectId | undefined;

    try {
        const provinciaExistente = await Provincia.findOne({ nombre: record.provincia }).exec();
        const localidadExistente = provinciaExistente
            ? await Localidad.findOne({
                nombre: record.municipio,
                provincia: provinciaExistente._id
            }).exec()
            : null;

        const provincia = provinciaExistente ?? await Provincia.create({ nombre: record.provincia });
        if (!provinciaExistente) idProvinciaNueva = provincia._id;

        const localidad = localidadExistente ?? await Localidad.create({
            nombre: record.municipio,
            provincia: provincia._id
        });
        if (!localidadExistente) idLocalidadNueva = localidad._id;

        if (await Entidad.exists({ nombre: record.nombre, localidad: localidad._id })) {
            throw new Error('Entidad duplicada: ya existe en la base de datos.');
        }

        await Entidad.create({
            nombre: record.nombre,
            ambito: record.ambito,
            direccion: record.direccion,
            codigo_postal: record.codigoPostal,
            latitud: coordenadas.latitud,
            longitud: coordenadas.longitud,
            localidad: localidad._id,
            ...(record.url ? { URL: record.url } : {}),
            ...(record.contacto ? { contacto: record.contacto } : {}),
            ...(record.descripcion ? { descripcion: record.descripcion } : {})
        });

        return {
            provinciaNueva: !provinciaExistente,
            localidadNueva: !localidadExistente
        };
    } catch (error: unknown) {
        if (idLocalidadNueva) await Localidad.deleteOne({ _id: idLocalidadNueva }).exec();
        if (idProvinciaNueva) await Provincia.deleteOne({ _id: idProvinciaNueva }).exec();
        throw error;
    }
};

const clasificarRegistros = async (
    registros: RegistroCatPreparado[],
    resumen: ResumenImportacionCat
): Promise<Array<RegistroCatPreparado & { ambito: Ambito }>> => {
    const ambitosIA = await clasificarAmbitosConIA(
        registros.map(({ nombre, descripcion }) => ({ nombre, descripcion }))
    );

    registros.forEach((registro, indice) => {
        registro.ambito = ambitosIA[indice] ?? registro.ambito;
    });

    return registros.filter((registro): registro is RegistroCatPreparado & { ambito: Ambito } => {
        if (registro.ambito) return true;
        resumen.rechazados.push({
            registro: registro.nombre,
            motivo: 'No se pudo determinar un ámbito válido'
        });
        console.warn(red(`[CAT] Rechazado - ${registro.nombre}: No se pudo determinar un ámbito válido`));
        return false;
    });
};

/** Importa entidades válidas; cada registro falla de forma aislada. */
export const extractCAT = async (
    filePath = DEFAULT_CAT_FILE
): Promise<ResumenImportacionCat> => {
    const summary = crearResumen();
    // Fases 1 y 2: leer el XML y convertirlo a registros internos.
    const registrosConvertidos = await leerRegistrosCat(filePath);

    // Fase 3: validar datos y descartar duplicados.
    const records = prepararRegistros(registrosConvertidos, summary);

    // Fase 4: obtener el ámbito de cada entidad con IA o clasificación local.
    console.log(`[CAT] ${records.length} registros válidos preparados. Clasificando ámbitos...`);
    const recordsConAmbito = await clasificarRegistros(records, summary);
    console.log('[CAT] Clasificación terminada. Geocodificando e importando entidades...');

    for (const [index, record] of recordsConAmbito.entries()) {
        try {
            console.log(`[CAT] Consultando ubicación ${index + 1}/${recordsConAmbito.length}: ${record.nombre}`);

            // Fase 5: buscar las coordenadas de la dirección.
            const coordenadas = await obtenerCoordenadas(record);
            if (!coordenadas) {
                summary.rechazados.push({ registro: record.nombre, motivo: 'No se pudieron obtener coordenadas válidas' });
                console.warn(red(
                    `[CAT] Rechazado - ${record.nombre}: No se pudieron obtener coordenadas válidas`
                ));
                continue;
            }

            // Fase 6: crear relaciones e insertar la entidad en MongoDB.
            const resultadoGuardado = await guardarEntidadCat(record, coordenadas);
            if (resultadoGuardado.provinciaNueva) summary.provincias += 1;
            if (resultadoGuardado.localidadNueva) summary.localidades += 1;
            summary.entidades += 1;
            console.log(green(`[CAT] Entidad insertada: "${record.nombre}"`));
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            summary.rechazados.push({ registro: record.nombre, motivo: `Error al guardar: ${message}` });
            console.warn(red(`[CAT] Rechazado - ${record.nombre}: Error al guardar: ${message}`));
        }
    }

    console.log(
        `[CAT] Resumen: ${summary.entidades} entidades insertadas, ` +
        `${summary.reparados.length} reparados, ${summary.rechazados.length} rechazados y ` +
        `${summary.duplicados.length} duplicados.`
    );
    imprimirIncidencias('Reparado', summary.reparados);
    imprimirIncidencias('Rechazado', summary.rechazados);
    imprimirIncidencias('Duplicado', summary.duplicados);
    return summary;
};

const imprimirIncidencias = (label: string, incidencias: Incidencia[]): void => {
    const color = label === 'Reparado' ? orange : red;
    incidencias.slice(0, 20).forEach(({ registro, motivo }) => {
        console.log(color(`[CAT] ${label} - ${registro}: ${motivo}`));
    });
    if (incidencias.length > 20) console.log(`[CAT] ${label}: ... y ${incidencias.length - 20} más`);
};

const run = async (): Promise<void> => {
    const filePathArgument = process.argv[2];
    const filePath = filePathArgument ? path.resolve(process.cwd(), filePathArgument) : DEFAULT_CAT_FILE;

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
