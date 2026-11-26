// Configuración pública de la página de pago (nada de esto es secreto).
window.PAGO = {
  // 'sandbox' para pruebas, 'production' para cobrar de verdad.
  entorno: 'sandbox',
  // Paddle → Developer tools → Authentication → Client-side tokens (empieza por test_ o live_).
  tokenCliente: 'test_d23e7593ffd3e881ad7df1d2323',
  apps: {
    fotogestor: {
      nombre: 'FotoGestor',
      planes: [
        { id: 'pri_01m8cxbq6p64a1jv1rmmadx03t', nombre: 'Mensual', precio: '9,99 €', periodo: 'al mes' },
        { id: 'pri_01m8cxcf1qwy1dn92vq9y1qzm5', nombre: 'Anual', precio: '99 €', periodo: 'al año', nota: '2 meses gratis' }
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
