const {Builder, Browser, By, Key, until} = require('selenium-webdriver'); 
import chrome from 'selenium-webdriver/chrome';
interface InfoGeocodificada {
  codigoPostal: string;
  latitud: string;
  longitud: string;
}
export const conseguirCoordenadasGPS = async function conseguirCoordenadasGPS(direccion : string) {
     let driver = null; 
    const chromeOptions = new chrome.Options();
  let InfoGeocodificada: InfoGeocodificada = {
        codigoPostal: '',
        latitud: '',
        longitud: ''
    };
chromeOptions.addArguments('--deny-permission-prompts');  

    try {
        driver = await new Builder().forBrowser(Browser.CHROME).setChromeOptions(chromeOptions).build();
        await driver.get('https://www.coordenadas-gps.com/');
        try {
            const btnCookies = await driver.wait(until.elementLocated(By.css('.fc-cta-consent')), 5000);
            if (await btnCookies.isDisplayed()) {
                await btnCookies.click();
            }
        } catch (e) {
        }
        await driver.sleep(2000);
        const inputDireccion = await driver.findElement(By.id('address'));
        await inputDireccion.click();
        await inputDireccion.clear();
        await inputDireccion.sendKeys(direccion);
        const btnObtener = await driver.findElement(By.css("button[onclick='codeAddress()']"));
        await btnObtener.click();
        await driver.executeScript("window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });");
        await driver.sleep(2000);

const infoWindow = await driver.findElement(By.id('info_window'));
        const textoCompleto = await infoWindow.getText();
        const latMatch = textoCompleto.match(/Latitud:\s*([-\d.]+)/i);
        const lngMatch = textoCompleto.match(/Longitud:\s*([-\d.]+)/i);
        const cpMatch = textoCompleto.match(/\b\d{5}\b/);

        console.log("textoCompleto:", textoCompleto);
        console.log("latMatch:", latMatch);
        console.log("lngMatch:", lngMatch);
        console.log("cpMatch:", cpMatch);

        const codigoPostal: string = cpMatch ? cpMatch[0] : '';
        const latitud: string = latMatch ? latMatch[1] : '';
        const longitud: string = lngMatch ? lngMatch[1] : '';
        InfoGeocodificada.codigoPostal = codigoPostal;
        InfoGeocodificada.latitud = latitud;
        InfoGeocodificada.longitud = longitud;
        console.log("InfoGeocodificada:", InfoGeocodificada);
 } catch (error) {
        console.error('Error al obtener las coordenadas GPS:', error);
    }finally {
    await driver.quit();
   return { 
    latitud: InfoGeocodificada.latitud,
    longitud: InfoGeocodificada.longitud,
    codigo_postal: InfoGeocodificada.codigoPostal

    };
    }

};
