import express from 'express'
import cors from 'cors'
import { Server } from 'socket.io'
import { createServer } from 'http'
import mediasoup from 'mediasoup'

// кодеки
import { mediaCodecs } from './mediacodecs.js'

const PORT = 5000
const app = express()

app.use(
  cors({
    origin: 5000,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true,
  })
)

app.get('/', (_req, res) => {
  res.send('Hello from mediasoup app!')
})

const server = createServer(app)

const io = new Server(server, {
  cors: {
    origin: '*',
  },
  serveClient: false,
})

server.listen(PORT, () => {
  console.log('listening on port: ' + PORT)
})

// метод of позволяет создать пространство имен, для разделения логики приложения
// по одному общему соединению (также называемому «мультиплексированием»).
const peers = io.of('/mediasoup') // создали пространство имен для mediasoup

let producerTransport
let consumerTransport
let producer
let consumer

// функция создает worker который будет работать на портах 2000 - 2020
const createWorker = async () => {
  const worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  })
  console.log(`worker pid ${worker.pid}`)

  // если worker умрет мы останавливаем приложение
  worker.on('died', (_error) => {
    console.error('mediasoup worker has died')
    setTimeout(() => process.exit(1), 2000) // exit in 2 seconds
  })

  return worker
}

const worker = await createWorker()

// слушаем подключения для выделенного пространства имен
peers.on('connection', async (socket) => {
  // после успешного подключения высылаем коннекту id сокет соединения
  socket.emit('connection-success', {
    socketId: socket.id,
  })

  // пишем лог в случае отключения
  socket.on('disconnect', () => {
    console.log('peer disconnected')
  })

  // для подключившегося клиента создаем маршрут. Параметрами передаем поддерживаемые кодеки
  const router = await worker.createRouter({ mediaCodecs })

  // Клиент генерирует событие что бы Client emits a request for RTP Capabilities
  // This event responds to the request
  socket.on('getRtpCapabilities', (callback) => {
    const rtpCapabilities = router.rtpCapabilities

    // вызываем колбек для того что бы  вернуть на клиент конфигурацию маршрутизатора (rtpCapabilities)
    callback({ rtpCapabilities })
  })

  // На клиенте генерируется событие для создания транспорта на стороне сервера
  // Тут нам надо разделить пользователей на продюсера (поставщика потока) и на потребителя
  socket.on('createWebRtcTransport', async ({ sender }, callback) => {
    console.log(`Is this a sender request? ${sender}`)
    // с клиента должен придти флаг sender, если true - то это producer,иначе - это потребитель
    if (sender) {
      producerTransport = await createWebRtcTransport(callback, router) // Продюсер
    } else {
      consumerTransport = await createWebRtcTransport(callback, router) // Потребитель
    }
  })

  // see client's socket.emit('transport-connect', ...)
  socket.on('transport-connect', async ({ dtlsParameters }) => {
    console.log('DTLS PARAMS... ', { dtlsParameters })
    await producerTransport.connect({ dtlsParameters })
  })

  // see client's socket.emit('transport-produce', ...)
  socket.on(
    'transport-produce',
    async ({ kind, rtpParameters, appData }, callback) => {
      // создаем инстанс продюсера, вызвав метод produce передав ему RTP параметры склиента
      producer = await producerTransport.produce({
        kind,
        rtpParameters,
      })

      console.log('Producer ID: ', producer.id, producer.kind)

      producer.on('transportclose', () => {
        console.log('transport for this producer closed ')
        producer.close()
      })

      // Send back to the client the Producer's id
      callback({
        id: producer.id,
      })
    }
  )

  // see client's socket.emit('transport-recv-connect', ...)
  socket.on('transport-recv-connect', async ({ dtlsParameters }) => {
    console.log(`DTLS PARAMS: ${dtlsParameters}`)
    await consumerTransport.connect({ dtlsParameters })
  })

  socket.on('consume', async ({ rtpCapabilities }, callback) => {
    try {
      // check if the router can consume the specified producer
      if (
        router.canConsume({
          producerId: producer.id,
          rtpCapabilities,
        })
      ) {
        // transport can now consume and return a consumer
        consumer = await consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
        })

        consumer.on('transportclose', () => {
          console.log('transport close from consumer')
        })

        consumer.on('producerclose', () => {
          console.log('producer of consumer closed')
        })

        // from the consumer extract the following params
        // to send back to the Client
        const params = {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        }

        // send the parameters to the client
        callback({ params })
      }
    } catch (error) {
      console.log(error.message)
      callback({
        params: {
          error: error,
        },
      })
    }
  })

  socket.on('consumer-resume', async () => {
    console.log('consumer resume')
    await consumer.resume()
  })
})

const createWebRtcTransport = async (callback, router) => {
  try {
    // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
    const webRtcTransport_options = {
      listenIps: [
        {
          ip: '0.0.0.0', // replace with relevant IP address
          announcedIp: '127.0.0.1',
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    }
    // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
    const transport = await router.createWebRtcTransport(
      webRtcTransport_options
    )

    transport.on('dtlsstatechange', (dtlsState) => {
      if (dtlsState === 'closed') {
        transport.close()
      }
    })

    transport.on('close', () => {
      console.log('transport closed')
    })

    // send back to the client the following prameters
    callback({
      // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    })

    return transport
  } catch (error) {
    console.log(error)
    callback({
      params: {
        error: error,
      },
    })
  }
}
