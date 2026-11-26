// Configuración pública de la página de pago (nada de esto es secreto).
window.PAGO = {
  // 'sandbox' para pruebas, 'production' para cobrar de verdad.
  entorno: 'sandbox',
  // Paddle → Developer tools → Authentication → Client-side tokens (empieza por test_ o live_).
  tokenCliente: '',
  apps: {
    fotogestor: {
      nombre: 'FotoGestor',
      planes: [
        { id: '', nombre: 'Mensual', precio: '9,99 €', periodo: 'al mes' },
        { id: '', nombre: 'Anual', precio: '99 €', periodo: 'al año', nota: '2 meses gratis' }
      ]
    },
    appclase: {
      nombre: 'AppClase',
      planes: [
        { id: '', nombre: 'Mensual', precio: '2,99 €', periodo: 'al mes' },
        { id: '', nombre: 'Anual', precio: '24,99 €', periodo: 'al año', nota: '2 meses gratis' }
      ]
    }
  }
}
