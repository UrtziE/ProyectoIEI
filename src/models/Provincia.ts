import mongoose, { Document, Model } from 'mongoose';
import { enableUpdateValidation, nonBlankString } from '../middleware/schemaValidation';

export interface ProvinciaDocument extends Document {
    codigo: mongoose.Types.ObjectId;
    nombre: string;
}

const ProvinciaSchema = new mongoose.Schema<ProvinciaDocument>({
    codigo: {
        type: mongoose.Schema.Types.ObjectId,
        required: [true, 'El código de la provincia es necesario.'],
        unique: true,
        default: () => new mongoose.Types.ObjectId()
    },
    nombre: {
        type: String,
        required: [true, 'El nombre de la provincia es necesario.'],
        trim: true,
        validate: nonBlankString
    }
});

enableUpdateValidation(ProvinciaSchema);

const Provincia: Model<ProvinciaDocument> = mongoose.model<ProvinciaDocument>('Provincia', ProvinciaSchema);

export default Provincia;