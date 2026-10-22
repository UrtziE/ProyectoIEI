import path from 'path';
import csvToJson from 'convert-csv-to-json';
import { EntidadDocument, Ambito } from '../models/Entidad';
import Provincia from '../models/Provincia';

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

export function extraer(fuente: Record<string,string>[]): EntidadDocument[]{
    const resultado: EntidadDocument[] = [];

    for (const registro of fuente) {
        const ambito = MAPEO_AMBITO[registro.sector];
        if (!ambito) {
        continue; // sector desconocido: se descarta
        }

        resultado.push({
        //cod_entidad: registro.id,
        nombre: registro.nombre,
        ambito,
        direccion: registro.domici,
        descripcion: construirDescripcion(registro),
        contacto: construirContacto(registro),

        var prov = Provincia{
            nombre = registro.provincia;
        }

        localidad: registro.municipio,
        });
    }

    return resultado;
}


