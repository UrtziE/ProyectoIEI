import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import connectDB from '../config/database';
import Entidad, { Ambito } from '../models/Entidad';
import Localidad from '../models/Localidad';
import Provincia from '../models/Provincia';
import vaciarBaseDatos from '../utils/vaciarBaseDatos';
import { green, orange, red } from '../utils/terminalOutput';
import { normalizarUrl } from '../utils/normalizarUrl';
import { normalizarDireccion } from '../utils/normalizarDireccion';
import {conseguirCoordenadasGPS} from '../robot/seleniumScraper'
const VALOR_DESCONOCIDO = '_U';
const DEFAULT_CAN_FILE = path.resolve(process.cwd(), 'src/public/fuentes_de_datos/datos-abiertos-csv-segundo-trimestre26.json');

interface RegistroCan {
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

interface ResumenImportacion {
    provincias: number;
    localidades: number;
    entidades: number;
    rechazados: Array<{ registro: string; motivo: string }>;
}

interface OpcionesExtraccion {
    clearDatabase?: boolean;
}

const imprimirRechazos = (rechazados: ResumenImportacion['rechazados']): void => {
    rechazados.slice(0, 20).forEach(({ registro, motivo }) => {
        console.log(red(`[CAN] Rechazado - ${registro}: ${motivo}`));
    });
    if (rechazados.length > 20) {
        console.log(`[CAN] Rechazado: ... y ${rechazados.length - 20} más`);
    }
};

const obtenerTextoObligatorio = (
    value: string | undefined,
    field: string,
    index: number,
    permitirDescripcionDesconocida = false
): string => {
    const trimmedValue = value?.trim();
    const isUnknownDescription = trimmedValue ? /^desconocid/i.test(trimmedValue) : false;
    if (!trimmedValue || trimmedValue === VALOR_DESCONOCIDO ||
        (isUnknownDescription && !permitirDescripcionDesconocida)) {
        throw new Error(`Falta un valor válido para el campo "${field}" en el registro ${index + 1}.`);
    }

    return trimmedValue;
};

const copiarTextoOpcional = (value: string | undefined): string | undefined => {
    if (!value || value === VALOR_DESCONOCIDO || value.trim() === '') {
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
    { area: 'Varios', ambito: 'VOLUNTARIADO_Y_PARTICIPACION_COMUNITARIA' }
];

const obtenerAmbito = (area: string, subarea: string | undefined): Ambito => {
    const areaNormalizada = normalizarCategoria(area);
    const subareaNormalizada = normalizarCategoria(subarea);
    const regla = REGLAS_AMBITO.find(({ area: areaEsperada, subarea: subareaEsperada }) =>
        (areaEsperada === undefined || areaNormalizada === normalizarCategoria(areaEsperada)) &&
        (subareaEsperada === undefined || subareaNormalizada.includes(normalizarCategoria(subareaEsperada)))
    );

    if (regla) return regla.ambito;

    throw new Error(`No existe un mapping de ambito para area "${area}" y subarea "${subarea ?? VALOR_DESCONOCIDO}".`);
};

const construirDireccion = (registro: RegistroCan, provincia: string, municipio: string): string => {
    const via = [
        registro.direccion_tipo_via,
        registro.direccion_nombre_via,
        registro.direccion_numero
    ].map(copiarTextoOpcional)
        .filter((value): value is string => value !== undefined)
        .join(' ');
    const viaNormalizada = normalizarDireccion(via);
    if (viaNormalizada !== via) {
        console.log(orange(`[CAN] Dirección adaptada para la búsqueda: "${via}" -> "${viaNormalizada}"`));
    }
    const ubicacion = [
        municipio,
        ...(normalizarCategoria(municipio) === normalizarCategoria(provincia) ? [] : [provincia])
    ]
        .join(', ');

    return [viaNormalizada, ubicacion].filter((value) => value !== '').join(', ');
};

const construirTextoCompuesto = (parte1: string | undefined, parte2: string | undefined): string => {
    const primerValor = copiarTextoOpcional(parte1);
    const segundoValor = copiarTextoOpcional(parte2);
    if (primerValor && segundoValor) {
        return primerValor + ' / ' + segundoValor;
    }  
    if (primerValor) {
        return primerValor;
    }
    if (segundoValor) {
        return segundoValor;
    }
    return 'No disponible';
};


const leerFicheroCan = async (filePath: string): Promise<RegistroCan[]> => {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(content);

    if (!Array.isArray(parsed)) {
        throw new Error(`El fichero ${filePath} debe contener un array JSON.`);
    }

    return parsed as RegistroCan[];
};

interface DatosCanPreparados {
    nombre: string;
    ambito: Ambito;
    direccion: string;
    codigoPostal: string;
    latitud: number;
    longitud: number;
    descripcion: string;
    contacto: string;
    provincia: string;
    municipio: string;
    url?: string;
}

const prepararRegistroCan = async (
    registro: RegistroCan,
    indice: number
): Promise<DatosCanPreparados> => {
    const nombre = obtenerTextoObligatorio(registro.denominacion, 'denominacion', indice);
    const provincia = obtenerTextoObligatorio(
        registro.direccion_provincia_nombre,
        'direccion_provincia_nombre',
        indice,
        true
    );
    const municipio = obtenerTextoObligatorio(
        registro.direccion_municipio_nombre,
        'direccion_municipio_nombre',
        indice
    );
    const area = obtenerTextoObligatorio(registro.area_nombre, 'area_nombre', indice);
    const ambito = obtenerAmbito(area, copiarTextoOpcional(registro.subarea_nombre));
    const direccion = construirDireccion(registro, provincia, municipio);
    const coordenadas = await conseguirCoordenadasGPS(direccion);
    const codigoPostal = coordenadas.codigo_postal?.trim() ?? '';

    if (!/^\d{5}$/.test(codigoPostal) ||
        (!codigoPostal.startsWith('35') && !codigoPostal.startsWith('38'))) {
        throw new Error(`Código postal inválido o fuera de Canarias: "${codigoPostal}"`);
    }

    const longitud = coordenadas.longitud ? Number(coordenadas.longitud) : undefined;
    const latitud = coordenadas.latitud ? Number(coordenadas.latitud) : undefined;
    if (longitud === undefined || latitud === undefined ||
        !Number.isFinite(longitud) || !Number.isFinite(latitud)) {
        throw new Error('No se obtuvieron coordenadas válidas');
    }

    return {
        nombre,
        ambito,
        direccion,
        codigoPostal,
        longitud,
        latitud,
        descripcion: construirTextoCompuesto(registro.subarea_nombre, registro.area_nombre),
        contacto: construirTextoCompuesto(registro.telefono_1, registro.telefono_2),
        provincia,
        municipio,
        url: normalizarUrl(registro.pagina_web)
    };
};

const guardarRegistroCan = async (
    datos: DatosCanPreparados
): Promise<{ provinciaNueva: boolean; localidadNueva: boolean }> => {
    let idProvinciaNueva: mongoose.Types.ObjectId | undefined;
    let idLocalidadNueva: mongoose.Types.ObjectId | undefined;

    try {
        const provinciaExistente = await Provincia.findOne({ nombre: datos.provincia }).exec();
        const provincia = provinciaExistente ??
            await Provincia.create({ nombre: datos.provincia });
        if (!provinciaExistente) idProvinciaNueva = provincia._id;

        const localidadExistente = await Localidad.findOne({
            nombre: datos.municipio,
            provincia: provincia._id
        }).exec();
        const localidad = localidadExistente ?? await Localidad.create({
            nombre: datos.municipio,
            provincia: provincia._id
        });
        if (!localidadExistente) idLocalidadNueva = localidad._id;

        if (await Entidad.exists({ nombre: datos.nombre, localidad: localidad._id })) {
            throw new Error('Entidad duplicada: ya existe en la base de datos.');
        }

        await Entidad.create({
            nombre: datos.nombre,
            ambito: datos.ambito,
            direccion: datos.direccion,
            codigo_postal: datos.codigoPostal,
            longitud: datos.longitud,
            latitud: datos.latitud,
            descripcion: datos.descripcion,
            contacto: datos.contacto,
            localidad: localidad._id,
            ...(datos.url ? { URL: datos.url } : {})
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

export const extractCAN = async (
    filePath = DEFAULT_CAN_FILE,
    options: OpcionesExtraccion = {}
): Promise<ResumenImportacion> => {
    const records = await leerFicheroCan(filePath);
    if (options.clearDatabase === true) await vaciarBaseDatos();

    const summary: ResumenImportacion = {
        provincias: 0,
        localidades: 0,
        entidades: 0,
        rechazados: []
    };

    for (const [index, record] of records.entries()) {
        try {
        const datos = await prepararRegistroCan(record, index);
        const resultado = await guardarRegistroCan(datos);
        if (resultado.provinciaNueva) summary.provincias += 1;
        if (resultado.localidadNueva) summary.localidades += 1;
        summary.entidades += 1;
        console.log(green(`[CAN] Entidad insertada: "${datos.nombre}"`));
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            const registro = record.denominacion?.trim() || `registro ${index + 1} (sin denominación)`;
            summary.rechazados.push({ registro, motivo: message });
            console.warn(red(`[CAN] Rechazado - ${registro}: ${message}`));
        }
    }

    console.log(
        `[CAN] Resumen: ${summary.entidades} entidades insertadas, ` +
        `${summary.rechazados.length} rechazados, ${summary.provincias} provincias nuevas y ` +
        `${summary.localidades} localidades nuevas.`
    );
    imprimirRechazos(summary.rechazados);
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
        `${summary.localidades} localidades y ${summary.entidades} entidades; ` +
        `${summary.rechazados.length} rechazados.`
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
