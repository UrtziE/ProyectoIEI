import path from 'path';
import csvToJson from 'convert-csv-to-json';
import { EntidadDocument, Ambito } from '../models/Entidad';
import Provincia from '../models/Provincia';
import Localidad from '../models/Localidad';
import Entidad from '../models/Entidad';

import mongoose from 'mongoose';
import connectDB from '../config/database';
import { conseguirCoordenadasGPS } from '../robot/seleniumScraper';
import { green, orange, red } from '../utils/terminalOutput';
import { normalizarDireccion } from '../utils/normalizarDireccion';
import { normalizarUrl } from '../utils/normalizarUrl';


const PREFIJOS_CP_CV = ['03', '12', '46'];

const ruta = path.resolve(process.cwd(), 'src', 'public', 'fuentes_de_datos', 'entidades_CV.csv');

export function extraerJsonCV(): Record<string,string>[]{
    const registros = csvToJson
        .fieldDelimiter(',')
        .supportQuotedField(true)
        .getJsonFromCsv(ruta);

    return registros
}

const MAPEO_AMBITO: Record<string, Ambito>= {
  'PERSONAS MAYORES': 'MAYORES',
  'PERSONAS CON DISCAPACIDAD': 'DISCAPACIDAD',
  'PERSONAS CON ENFERMEDAD MENTAL': 'SALUD_MENTAL',
  'INFANCIA': 'INFANCIA_Y_JUVENTUD',
  'MUJERES': 'MUJER',
  'PERSONAS MIGRANTES': 'MIGRACION',
  'POBLACION EN GENERAL Y COLECTIVOS SOCIALMENTE DESFAVORECIDOS': 'INCLUSION_SOCIAL',
}

function normalizarTexto(texto: string): string {
    return texto
        .trim()                          // por si el CSV arrastra espacios
        .toLocaleUpperCase('es-ES')      // mayúsculas (collate español)
        .normalize('NFD')                // separa la Ó en "O" + marca de tilde (combining char)
        .replace(/[\u0300-\u036f]/g, ''); // elimina esas marcas → "Ó" queda como "O"
}

function construirDescripcion(registro: Record<string, string>): string {
    return registro.tipo_centro + "\n" + registro.clasificacion + "\n" + registro.leyenda;
}

function extraerTelefonos(fuente: string): string[] {
    if (!fuente) return [];
    return fuente
        .split(/[-;]/)                 // separa por guión o punto y coma
        .map(t => t.replace(/\D/g, '')) // deja solo dígitos
        .filter(t => t.length >= 9);    // descarta los cortos
}

function construirContacto(registro: Record<string, string>): string {
    const telefonos = extraerTelefonos(registro.telefono);
    const tel = telefonos.length ? telefonos.join(' - ') : 'N/A';
    const email = registro.email?.trim() || 'N/A';
    return `Tel: ${tel} - Email: ${email}`;
}


function obtenerNombreCastellano(nombre: string): string {
    const partes = nombre.split('/');
    return partes[partes.length - 1].trim();
}

function construirUbicacionBusqueda(registro: Record<string, string>): string[] {
    const municipio = obtenerNombreCastellano(registro.municipio);
    const provincia = obtenerNombreCastellano(registro.provincia);
    const ubicacion = [municipio];
    if (normalizarTexto(municipio) !== normalizarTexto(provincia)) ubicacion.push(provincia);
    ubicacion.push('España');
    return ubicacion;
}

function construirDireccionBusqueda(registro: Record<string, string>): string {
    return [
        normalizarDireccion(registro.domici),
        ...construirUbicacionBusqueda(registro)
    ].filter(Boolean).join(', ');
}

interface Geocodificacion {
    codigoPostal: string;
    latitud: number;
    longitud: number;
}

interface Incidencia {
    registro: string;
    motivo: string;
}

const imprimirRechazos = (rechazados: Incidencia[]): void => {
    rechazados.slice(0, 20).forEach(({ registro, motivo }) => {
        console.log(red(`[extractorCV] Rechazado - ${registro}: ${motivo}`));
    });
    if (rechazados.length > 20) {
        console.log(`[extractorCV] Rechazado: ... y ${rechazados.length - 20} más`);
    }
};


async function obtenerGeocodificacion(direccion: string): Promise<Geocodificacion | null> {
    const coords = await conseguirCoordenadasGPS(direccion);
    const latitud = coords.latitud ? parseFloat(coords.latitud) : NaN;
    const longitud = coords.longitud ? parseFloat(coords.longitud) : NaN;
    const codigoPostal = coords.codigo_postal?.trim() ?? '';
    if (!Number.isNaN(latitud) && !Number.isNaN(longitud)) {
        return { codigoPostal, latitud, longitud };
    }
    return null;
}

export async function extraer(fuente: Record<string, string>[]): Promise<EntidadDocument[]> {
    const resultado: EntidadDocument[] = [];
    const rechazados: Incidencia[] = [];
    const registrarRechazo = (registro: string, motivo: string): void => {
        rechazados.push({ registro, motivo });
        console.warn(red(`[extractorCV] Rechazado - ${registro}: ${motivo}`));
    };

    for (const registro of fuente) {
      let provinciaNueva: mongoose.Types.ObjectId | undefined;
      let localidadNueva: mongoose.Types.ObjectId | undefined;
      try {
        const ambito = MAPEO_AMBITO[normalizarTexto(registro.sector)];
        if (!ambito) {
            registrarRechazo(
                registro.nombre || 'sin nombre',
                `Sector desconocido: ${registro.sector}`
            );
            continue; // sector desconocido: se descarta
        }

        const direccionBusqueda = construirDireccionBusqueda(registro);
        const direccionOriginal = [
            registro.domici,
            ...construirUbicacionBusqueda(registro)
        ].filter(Boolean).join(', ');
        if (direccionBusqueda !== direccionOriginal) {
            console.log(orange(
                `[extractorCV] Dirección adaptada para la búsqueda: ` +
                `"${direccionOriginal}" -> "${direccionBusqueda}"`
            ));
        }
        const geo = await obtenerGeocodificacion(direccionBusqueda);
        if (!geo) {
            registrarRechazo(
                registro.nombre || 'sin nombre',
                `Sin coordenadas (${direccionBusqueda})`
            );
            continue;
        }
        if (!geo.codigoPostal) {
            registrarRechazo(
                registro.nombre || 'sin nombre',
                `Sin código postal (${direccionBusqueda})`
            );
            continue;
        }
        if (!/^\d{5}$/.test(geo.codigoPostal) ||
            !PREFIJOS_CP_CV.some((prefijo) => geo.codigoPostal.startsWith(prefijo))) {
            registrarRechazo(
                registro.nombre || 'sin nombre',
                `Código postal inválido o fuera de la Comunitat Valenciana: "${geo.codigoPostal}"`
            );
            continue;
        }
        const url = normalizarUrl(registro.web);

        const provinciaExistente = await Provincia.findOne({ nombre: registro.provincia }).exec();
        const provincia = provinciaExistente ?? await Provincia.create({ nombre: registro.provincia });
        if (!provinciaExistente) provinciaNueva = provincia._id;

        const localidadExistente = await Localidad.findOne({
            nombre: registro.municipio,
            provincia: provincia._id
        }).exec();
        const localidad = localidadExistente ?? await Localidad.create({
            nombre: registro.municipio,
            provincia: provincia._id
        });
        if (!localidadExistente) localidadNueva = localidad._id;

        if (await Entidad.exists({ nombre: registro.nombre, localidad: localidad!._id })) {
            throw new Error('Entidad duplicada: ya existe en la base de datos.');
        }
        const entidad = await Entidad.create({
            nombre: registro.nombre,
            ambito,
            direccion: registro.domici,
            codigo_postal: geo.codigoPostal,
            latitud: geo.latitud,
            longitud: geo.longitud,
            descripcion: construirDescripcion(registro),
            contacto: construirContacto(registro),
            ...(url ? { URL: url } : {}),
            localidad: localidad!._id
        });
        resultado.push(entidad);
        console.log(green(`[extractorCV] Entidad insertada: "${registro.nombre}"`));
      } catch (error: unknown) {
        if (localidadNueva) await Localidad.deleteOne({ _id: localidadNueva }).exec();
        if (provinciaNueva) await Provincia.deleteOne({ _id: provinciaNueva }).exec();
        const message = error instanceof Error ? error.message : String(error);
        registrarRechazo(registro.nombre || 'sin nombre', message);
      }
    }

    console.log(
        `[extractorCV] Resumen: ${resultado.length} entidades insertadas, ` +
        `${rechazados.length} rechazadas.`
    );
    imprimirRechazos(rechazados);
    return resultado;
}

if(require.main === module){
    (async () => {
        try {
            await connectDB();
            const registros = extraerJsonCV();
            const entidades = await extraer(registros);
            console.log(`[extractorCV] ${entidades.length} entidades procesadas`);
        } catch(error) {
            console.error('[extractorCV] Error:', error);
            process.exitCode = 1;
        } finally {
            await mongoose.disconnect();
        }
    })();
}


