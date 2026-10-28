import path from 'path';
import csvToJson from 'convert-csv-to-json';
import { EntidadDocument, Ambito } from '../models/Entidad';
import Provincia from '../models/Provincia';
import Localidad from '../models/Localidad';
import Entidad from '../models/Entidad';

import mongoose from 'mongoose';
import connectDB from '../config/database';

const ruta = path.join(__dirname,  '..', 'public', 'fuentes_de_datos', 'CV.csv');

function extraerJsonCV(): Record<string,string>[]{
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

export async function extraer(fuente: Record<string,string>[]): Promise<EntidadDocument[]>{
    const resultado: EntidadDocument[] = [];

    for (const registro of fuente) {
        const ambito = MAPEO_AMBITO[normalizar(registro.sector)];
        if (!ambito) {
            console.warn(`[extractorCV] Sector desconocido, fila descartada: ${registro.sector}`);
            continue; // sector desconocido: se descarta
        }

        const codigoProvincia = registro.cod_ine_mun.slice(0, 2);
        const provincia = await Provincia.findOneAndUpdate(
            { codigo: codigoProvincia },
            { codigo: codigoProvincia, nombre: registro.provincia },
            { upsert: true, new: true, runValidators: true }
        )

        const localidad = await Localidad.findOneAndUpdate(
            { codigo: registro.cod_ine_mun },
            { codigo: registro.cod_ine_mun, nombre: registro.municipio, provincia: provincia!._id },
            { upsert: true, new: true, runValidators: true }
        )

        const entidad = await Entidad.findOneAndUpdate(
            { cod_entidad: registro.id },
            { cod_entidad: registro.id, 
              nombre: registro.nombre, 
              ambito,
              direccion: registro.domici,
              descripcion: construirDescripcion(registro),
              contacto: construirContacto(registro),
              localidad: localidad!._id },
            { upsert: true, new: true, runValidators: true }
        );
        resultado.push(entidad!);
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


