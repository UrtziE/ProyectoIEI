const mongoose = require("mongoose");

const ProvinciaSchema = new mongoose.Schema({
    codigo: { 
        type: String, 
        required: [true, 'El código de la provincia es necesario.'],
        unique: true 
    },
    nombre: { 
        type: String, 
        required: [true, 'El nombre de la provincia es necesario.'] 
    }
});

module.exports = mongoose.model("Provincia", ProvinciaSchema);