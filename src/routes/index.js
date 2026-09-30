var express = require('express');
var router = express.Router();

const {getHomePage} = require("../controllers/home/homeController");


router.get('/',getHomePage)


module.exports = router;