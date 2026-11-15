import { conseguirCoordenadasGPS } from './seleniumScraper';

async function probar() {
  console.log('Llamando al método conseguirCoordenadasGPS...');
  
  const resultado = await conseguirCoordenadasGPS('Calle Sociedad De Pastos 89, Ingenio, Las Palmas');

  console.log('Resultado obtenido:', resultado);
}

probar();