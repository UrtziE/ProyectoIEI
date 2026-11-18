import path from 'path';
import csvToJson from 'convert-csv-to-json';
import { EntidadDocument, Ambito } from '../models/Entidad';
import Provincia from '../models/Provincia';
import Localidad from '../models/Localidad';
import Entidad from '../models/Entidad';

import mongoose from 'mongoose';
import proj4 from 'proj4';
import connectDB from '../config/database';
import { conseguirCodigoPostalPorCoordenadas } from '../robot/seleniumScraper';
import { green, red } from '../utils/terminalOutput';
import { normalizarUrl } from '../utils/normalizarUrl';


const PREFIJOS_CP_CV = ['03', '12', '46'];
const UTM_CV = 'EPSG:25830';
const WGS84 = 'EPSG:4326';
proj4.defs(UTM_CV, '+proj=utm +zone=30 +ellps=GRS80 +units=m +no_defs +type=crs');

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


interface Coordenadas {
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


function convertirCoordenadasCSV(registro: Record<string, string>): Coordenadas | null {
    const parsear = (valor: string | undefined): number => {
        if (!valor?.trim()) return NaN;
        // El CSV contiene algún valor numérico con coma decimal (por ejemplo "4333847,00").
        const normalizado = valor.trim().replace(',', '.');
        return /^[-+]?\d+(\.\d+)?$/.test(normalizado) ? Number(normalizado) : NaN;
    };
    const x = parsear(registro.x_25830);
    const y = parsear(registro.y_25830);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    const [longitud, latitud] = proj4(UTM_CV, WGS84, [x, y]);
    if (!Number.isFinite(latitud) || !Number.isFinite(longitud) ||
        latitud < -90 || latitud > 90 || longitud < -180 || longitud > 180) return null;
    return { latitud, longitud };
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

        const coordenadas = convertirCoordenadasCSV(registro);
        if (!coordenadas) {
            registrarRechazo(
                registro.nombre || 'sin nombre',
                'Falta una coordenada UTM (x_25830 o y_25830) o no es válida'
            );
            continue;
        }
        const codigoPostalRegistro = await conseguirCodigoPostalPorCoordenadas(
            coordenadas.latitud,
            coordenadas.longitud
        );
        if (!/^\d{5}$/.test(codigoPostalRegistro) ||
            !PREFIJOS_CP_CV.some((prefijo) => codigoPostalRegistro.startsWith(prefijo))) {
            registrarRechazo(
                registro.nombre || 'sin nombre',
                `Código postal inválido o fuera de la Comunitat Valenciana: "${codigoPostalRegistro}"`
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
            codigo_postal: codigoPostalRegistro,
            latitud: coordenadas.latitud,
            longitud: coordenadas.longitud,
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


