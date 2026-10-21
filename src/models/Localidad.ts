import mongoose, { Document, Model } from 'mongoose';

export interface LocalidadDocument extends Document {
    codigo: mongoose.Types.ObjectId;
    nombre: string;
    provincia: mongoose.Types.ObjectId;
}

const LocalidadSchema = new mongoose.Schema<LocalidadDocument>({
    codigo: {
        type: mongoose.Schema.Types.ObjectId,
        required: [true, 'El código de la localidad es necesario.'],
        unique: true,
        default: () => new mongoose.Types.ObjectId()
    },
    nombre: {
        type: String,
        required: [true, 'El nombre de la localidad es necesario.']
    },
    provincia: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Provincia',
        required: [true, 'La referencia a la provincia es obligatoria.']
    }
});

const Localidad: Model<LocalidadDocument> = mongoose.model<LocalidadDocument>('Localidad', LocalidadSchema);

export default Localidad;