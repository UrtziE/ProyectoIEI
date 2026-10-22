import path from 'path';
import csvToJson from 'convert-csv-to-json';
import { EntidadDocument, Ambito } from '../models/Entidad';
import Provincia from '../models/Provincia';
import Localidad from '../models/Localidad';
import Entidad from '../models/Entidad';

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
  'DISCAPACIDAD': 'DISCAPACIDAD',
  'PERSONAS CON ENFERMEDAD MENTAL': 'SALUD_MENTAL',
  'INFANCIA': 'INFANCIA_Y_JUVENTUD',
  'MUJERES': 'MUJER',
  'PERSONAS MIGRANTES': 'MIGRACION',
  'POBLACION EN GENERAL Y COLECTIVOS SOCIALMENTE DESFAVORECIDOS': 'INCLUSION_SOCIAL',
}

function construirDescripcion(registro: Record<string, string>){
    return registro.tipo_centro + "\n" + registro.clasificación + "\n" + registro.leyenda;
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

export async function extraer(fuente: Record<string,string>[]): EntidadDocument[]{
    const resultado: EntidadDocument[] = [];

    for (const registro of fuente) {
        const ambito = MAPEO_AMBITO[registro.sector];
        if (!ambito) {
        continue; // sector desconocido: se descarta
        }

        const provincia = await Provincia.findOneAndUpdate(
            { codigo: codigoProvincia },
            { codigo: codigoProvincia, nombre: registro.provincia },
            { upsert: true, new: true, runValidators: true }
        )

        const localidad = await Localidad.findOneAndUpdate(
            { codigo: registro.cod_ine_mun },
            { codigo: registro.cod_ine_mun, nombre: registro.municipio, provincia: provincia._id },
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
              localidad: localidad._id },
            { upsert: true, new: true, runValidators: true }
        );
        
    }

    return resultado;
}


