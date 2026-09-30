const mongoose = require("mongoose");

const LocalidadSchema = new mongoose.Schema({
    codigo: { 
        type: String, 
        required: [true, 'El código de la localidad es necesario.'],
        unique: true 
    },
    nombre: { 
        type: String, 
        required: [true, 'El nombre de la localidad es necesario.'] 
    },
    // Relación +en_provincia del diagrama
    provincia: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Provincia',
        required: [true, 'La referencia a la provincia es obligatoria.']
    }
});

module.exports = mongoose.model("Localidad", LocalidadSchema);