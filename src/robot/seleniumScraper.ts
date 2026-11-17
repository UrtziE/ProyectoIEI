const {Builder, Browser, By, until} = require('selenium-webdriver');
import { WebDriver, WebElement } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome';
import { red } from '../utils/terminalOutput';
interface InfoGeocodificada {
  codigoPostal: string;
  latitud: string;
  longitud: string;
}
export const conseguirCoordenadasGPS = async function conseguirCoordenadasGPS(direccion : string) {
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
        const navegador = driver;
        await driver.manage().setTimeouts({ pageLoad: 20000, script: 10000, implicit: 5000 });
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
        // Se evita el clic "físico": un iframe de anuncios suele taparlo (ElementClickInterceptedError).
        // Se desplaza a la vista y se escribe directamente, sin hacer click con el puntero.
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", inputDireccion);
        await inputDireccion.clear();
        await inputDireccion.sendKeys(direccion);
        const palabrasDireccion = direccion
            .toLocaleLowerCase('es-ES')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .split(/[^a-z0-9]+/)
            .filter((palabra: string) => palabra.length >= 4 && !/^\d+$/.test(palabra))
            .filter((palabra: string) => !['calle', 'avenida', 'carretera', 'españa'].includes(palabra));
        const infoWindowsIniciales = await driver.findElements(By.id('info_window'));
        const textoInicial = infoWindowsIniciales.length
            ? await infoWindowsIniciales[0].getText()
            : '';
        const btnObtener = await driver.findElement(By.css("button[onclick='codeAddress()']"));
        // El botón también puede quedar tapado por anuncios: se pulsa vía JavaScript.
        await driver.executeScript("arguments[0].click();", btnObtener);
        await driver.executeScript("window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });");
        const infoWindow = await driver.wait<WebElement>(async () => {
            const infoWindows = await navegador.findElements(By.id('info_window'));
            if (!infoWindows.length) return false;
            const texto = await infoWindows[0].getText();
            const textoNormalizado = texto
                .toLocaleLowerCase('es-ES')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '');
            const contieneDireccion = palabrasDireccion.some((palabra: string) =>
                textoNormalizado.includes(palabra)
            );
            return texto && texto !== textoInicial && contieneDireccion &&
                /Latitud:/i.test(texto) && /Longitud:/i.test(texto)
                ? infoWindows[0]
                : false;
        }, 15000, `La web no devolvió un resultado válido para "${direccion}".`);
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
