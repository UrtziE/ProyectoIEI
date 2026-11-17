const {Builder, Browser, By, until} = require('selenium-webdriver');
import { WebDriver } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome';
import { orange, red } from '../utils/terminalOutput';
interface InfoGeocodificada {
  codigoPostal: string;
  latitud: string;
  longitud: string;
}
const buscarCoordenadasGPS = async function buscarCoordenadasGPS(direccion: string) {
     let driver: WebDriver | null = null;
    console.log(`[GPS] Buscando dirección: ${direccion}`);
    const chromeOptions = new chrome.Options();
  let InfoGeocodificada: InfoGeocodificada = {
        codigoPostal: '',
        latitud: '',
        longitud: ''
    };

chromeOptions.addArguments(
    '--deny-permission-prompts',
    '--disable-logging',
    '--log-level=3',
    '--remote-debugging-pipe'
);
chromeOptions.setChromeLogFile('NUL');

    try {
        const chromeService = new chrome.ServiceBuilder().setStdio('ignore');
        driver = await new Builder()
            .forBrowser(Browser.CHROME)
            .setChromeOptions(chromeOptions)
            .setChromeService(chromeService)
            .build();
        if (!driver) throw new Error('No se pudo iniciar Selenium.');
        await driver.manage().window().maximize();
        await driver.manage().setTimeouts({ pageLoad: 20000, script: 10000, implicit: 5000 });
        await driver.get('https://www.coordenadas-gps.com/');
        try {
            const btnCookies = await driver.wait(until.elementLocated(By.css('.fc-cta-consent')), 5000);
            if (await btnCookies.isDisplayed()) {
                await btnCookies.click();
            }
        } catch (e) {
        }
        await driver.sleep(6000);
        const inputDireccion = await driver.findElement(By.id('address'));
        await inputDireccion.clear();
        await driver.sleep(1000);
        await inputDireccion.clear();
        await inputDireccion.sendKeys(direccion);
        const btnObtener = await driver.findElement(By.css("button[onclick='codeAddress()']"));
        await driver.executeScript("arguments[0].click();", btnObtener);
        await driver.sleep(2000);
        const infoWindow = await driver.wait(until.elementLocated(By.id('info_window')), 11000);
        const textoCompleto = await infoWindow.getText();
        const latMatch = textoCompleto.match(/Latitud:\s*([-\d.]+)/i);
        const lngMatch = textoCompleto.match(/Longitud:\s*([-\d.]+)/i);
        // El CP se busca solo en la línea de la dirección (antes de "Latitud"): si la web no
        // devuelve CP, la regex no debe coger 5 dígitos de los decimales de la latitud.
        const lineaDireccion = textoCompleto.split(/Latitud:/i)[0];
        const cpMatch = lineaDireccion.match(/\b\d{5}\b/);

        const codigoPostal: string = cpMatch ? cpMatch[0] : '';
        const latitud: string = latMatch ? latMatch[1] : '';
        const longitud: string = lngMatch ? lngMatch[1] : '';
        InfoGeocodificada.codigoPostal = codigoPostal;
        InfoGeocodificada.latitud = latitud;
        InfoGeocodificada.longitud = longitud;
        console.log(`[GPS] CP=${codigoPostal || 'N/D'} | lat=${latitud || 'N/D'} | lon=${longitud || 'N/D'}`);
 } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(red(`[GPS] No se pudieron obtener coordenadas para "${direccion}": ${message}`));
    }finally {
    if (driver) await driver.quit();
   return { 
    latitud: InfoGeocodificada.latitud,
    longitud: InfoGeocodificada.longitud,
    codigo_postal: InfoGeocodificada.codigoPostal

    };

    }

};

export const conseguirCoordenadasGPS = async (direccion: string) => {
    let resultado = {
        latitud: '',
        longitud: '',
        codigo_postal: ''
    };
    let resultadoConCoordenadas = resultado;

    for (let intento = 1; intento <= 2; intento += 1) {
        resultado = await buscarCoordenadasGPS(direccion);
        if (resultado.latitud && resultado.longitud) {
            resultadoConCoordenadas = resultado;
            if (resultado.codigo_postal) return resultado;
        }
        if (intento < 2) {
            console.warn(orange(`[GPS] Reintentando búsqueda (${intento + 1}/2): "${direccion}"`));
        }
    }

    return resultadoConCoordenadas;
};
