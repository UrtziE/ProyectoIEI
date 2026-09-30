import mongoose, { Document, Model } from 'mongoose';

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
    'CULTURA_Y_DESARROLLO_COMUNITARIO'
] as const;

export type Ambito = typeof ambitos[number];

export interface EntidadDocument extends Document {
    cod_entidad: string;
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
        type: String,
        required: [true, 'El código de entidad es necesario.'],
        unique: true
    },
    nombre: {
        type: String,
        required: [true, 'El nombre es necesario.']
    },
    ambito: {
        type: String,
        required: true,
        enum: ambitos
    },
    direccion: { type: String },
    codigo_postal: { type: String },
    longitud: { type: Number },
    latitud: { type: Number },
    descripcion: { type: String },
    contacto: { type: String },
    URL: { type: String },
    localidad: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Localidad',
        required: [true, 'La referencia a la localidad es obligatoria.']
    }
});

const Entidad: Model<EntidadDocument> = mongoose.model<EntidadDocument>('Entidad', EntidadSchema);

export default Entidad;