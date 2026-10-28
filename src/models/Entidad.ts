import mongoose, { Document, Model } from 'mongoose';
import {
    enableUpdateValidation,
    httpUrl,
    latitude,
    longitude,
    nonBlankString,
    postalCode
} from '../middleware/schemaValidation';

export const ambitos = [
    'MAYORES',
    'DISCAPACIDAD',
    'SALUD_MENTAL',
    'INFANCIA_Y_JUVENTUD',
    'MUJER',
    'MIGRACION',
    'INCLUSION_SOCIAL',
    'EDUCACION_Y_FORMACION',
    'EMPLEO_E_INSERCION_LABORAL',
    'SALUD_Y_ATENCION_SOCIOSANITARIA',
    'VOLUNTARIADO_Y_PARTICIPACION_COMUNITARIA',
    'CULTURA_Y_DESARROLLO_COMUNITARIO',
    'SIN_CLASIFICAR'
] as const;

export type Ambito = typeof ambitos[number];

export interface EntidadDocument extends Document {
    cod_entidad: mongoose.Types.ObjectId;
    nombre: string;
    ambito: Ambito;
    direccion?: string;
    codigo_postal?: string;
    longitud?: number;
    latitud?: number;
    descripcion?: string;
    contacto?: string;
    URL?: string;
    localidad: mongoose.Types.ObjectId;
}

const EntidadSchema = new mongoose.Schema<EntidadDocument>({
    cod_entidad: {
        type: mongoose.Schema.Types.ObjectId,
        required: [true, 'El código de entidad es necesario.'],
        unique: true,
        default: () => new mongoose.Types.ObjectId()
    },
    nombre: {
        type: String,
        required: [true, 'El nombre es necesario.'],
        trim: true,
        validate: nonBlankString
    },
    ambito: {
        type: String,
        required: true,
        enum: ambitos
    },
    direccion: { type: String, trim: true },
    codigo_postal: { type: String, trim: true, validate: postalCode },
    longitud: { type: Number, validate: longitude },
    latitud: { type: Number, validate: latitude },
    descripcion: { type: String, trim: true },
    contacto: { type: String, trim: true },
    URL: { type: String, trim: true },
    localidad: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Localidad',
        required: [true, 'La referencia a la localidad es obligatoria.']
    }
});

enableUpdateValidation(EntidadSchema);

const Entidad: Model<EntidadDocument> = mongoose.model<EntidadDocument>('Entidad', EntidadSchema);

export default Entidad;
