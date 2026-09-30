const User = require("../../models/Provincia");

/*Home orrialdea kargatzeko*/
const getHomePage = async (req, res, next) => {
    if(res.locals.userId!==null){
        let user = await User.findById(res.locals.userId)
        let izena=user.name||"erabiltzaile";
        res.render('home', {izena: izena});
    }else{
        res.render('home')
    }
};


module.exports = { getHomePage };