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

function normalizar(texto: string): string {
    return texto
        .trim()                          // por si el CSV arrastra espacios
        .toLocaleUpperCase('es-ES')      // mayúsculas (collate español)
        .normalize('NFD')                // separa la Ó en "O" + marca de tilde (combining char)
        .replace(/[\u0300-\u036f]/g, ''); // elimina esas marcas → "Ó" queda como "O"
}

function construirDescripcion(registro: Record<string, string>){
    return registro.tipo_centro + "\n" + registro.clasificacion + "\n" + registro.leyenda;
}

function extraerTelefono(fuente: string): string[]{
    if (!fuente) return [];
    return fuente
        .split(/[-;]/)                 // separa por guión o punto y coma
        .map(t => t.replace(/\D/g, '')) // deja solo dígitos
        .filter(t => t.length >= 9);    // descarta los cortos
}

function construirContacto(registro: Record<string, string>){
    const telefonos = extraerTelefono(registro.telefono);
    const tel = telefonos.length ? telefonos.join(' - ') : 'N/A';
    const email = registro.email?.trim() || 'N/A';
    return `Tel: ${tel} - Email: ${email}`;
}


function nombreCastellano(nombre: string): string {
    const partes = nombre.split('/');
    return partes[partes.length - 1].trim();
}

function construirUbicacionBusqueda(registro: Record<string, string>): string[] {
    const municipio = nombreCastellano(registro.municipio);
    const provincia = nombreCastellano(registro.provincia);
    const ubicacion = [municipio];
    if (normalizar(municipio) !== normalizar(provincia)) ubicacion.push(provincia);
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


async function geocodificar(direccion: string): Promise<Geocodificacion | null> {
    for (let intento = 1; intento <= 2; intento += 1) {
        const coords = await conseguirCoordenadasGPS(direccion);
        const latitud = coords.latitud ? parseFloat(coords.latitud) : NaN;
        const longitud = coords.longitud ? parseFloat(coords.longitud) : NaN;
        const codigoPostal = coords.codigo_postal?.trim() ?? '';
        if (!Number.isNaN(latitud) && !Number.isNaN(longitud)) {
            return { codigoPostal, latitud, longitud };
        }
    }
    return null;
}

export async function extraer(fuente: Record<string,string>[]): Promise<EntidadDocument[]>{
    const resultado: EntidadDocument[] = [];

    for (const registro of fuente) {
      try {
        const ambito = MAPEO_AMBITO[normalizar(registro.sector)];
        if (!ambito) {
            console.warn(red(`[extractorCV] Sector desconocido, fila descartada: ${registro.sector}`));
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
        const geo = await geocodificar(direccionBusqueda);
        if (!geo) {
            console.warn(red(`[extractorCV] Sin coordenadas, fila descartada: "${registro.nombre}" (${direccionBusqueda})`));
            continue;
        }
        if (!geo.codigoPostal) {
            console.warn(red(
                `[extractorCV] Sin código postal, fila descartada: ` +
                `"${registro.nombre}" (${direccionBusqueda})`
            ));
            continue;
        }
        if (!/^\d{5}$/.test(geo.codigoPostal) ||
            !PREFIJOS_CP_CV.some((prefijo) => geo.codigoPostal.startsWith(prefijo))) {
            console.warn(red(
                `[extractorCV] Código postal inválido o fuera de la Comunitat Valenciana, fila descartada: ` +
                `"${registro.nombre}" (CP "${geo.codigoPostal}")`
            ));
            continue;
        }
        const url = normalizarUrl(registro.web);

        const provincia = await Provincia.findOneAndUpdate(
            { nombre: registro.provincia },
            { nombre: registro.provincia },
            { upsert: true, new: true, runValidators: true }
        )

        const localidad = await Localidad.findOneAndUpdate(
            { nombre: registro.municipio, provincia: provincia!._id },
            { nombre: registro.municipio, provincia: provincia!._id },
            { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
        )

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
        const message = error instanceof Error ? error.message : String(error);
        console.warn(red(`[extractorCV] Fila descartada: "${registro.nombre || 'sin nombre'}": ${message}`));
      }
    }

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


