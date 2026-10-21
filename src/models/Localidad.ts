import mongoose, { Document, Model } from 'mongoose';
import { enableUpdateValidation, nonBlankString } from '../middleware/schemaValidation';

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
        required: [true, 'El nombre de la localidad es necesario.'],
        trim: true,
        validate: nonBlankString
    },
    provincia: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Provincia',
        required: [true, 'La referencia a la provincia es obligatoria.']
    }
});

enableUpdateValidation(LocalidadSchema);

const Localidad: Model<LocalidadDocument> = mongoose.model<LocalidadDocument>('Localidad', LocalidadSchema);

export default Localidad;