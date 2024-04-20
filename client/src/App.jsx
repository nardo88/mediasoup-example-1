import { useEffect, useRef } from 'react'
import io from 'socket.io-client'
import { Device } from 'mediasoup-client'

import './App.css'

function App() {
  const socket = useRef()
  const localVideo = useRef(null)
  const device = useRef()
  const rtpCapabilities = useRef()
  const producerTransport = useRef()
  const producer = useRef()
  const params = useRef() // mediasoup params
  const consumerTransport = useRef()
  const consumer = useRef()
  const remoteVideo = useRef()

  useEffect(() => {
    socket.current = io('http://localhost:5000/mediasoup')

    socket.current.on('connection-success', ({ socketId }) => {
      console.log(socketId)
    })
  }, [])

  const getLocalVideo = () => {
    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: true,
      })
      .then((stream) => {
        params.current = {
          encodings: [
            {
              rid: 'r0',
              maxBitrate: 100000,
              scalabilityMode: 'S1T3',
            },
            {
              rid: 'r1',
              maxBitrate: 300000,
              scalabilityMode: 'S1T3',
            },
            {
              rid: 'r2',
              maxBitrate: 900000,
              scalabilityMode: 'S1T3',
            },
          ],
          // https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
          codecOptions: {
            videoGoogleStartBitrate: 1000,
          },
        }
        localVideo.current.srcObject = stream
        const track = stream.getVideoTracks()[0]
        params.current.track = track
      })
      .catch((error) => {
        console.log('error: ', error)
        console.warn('Нет доступа до камеры')
      })
  }

  const getRtpCapabilities = () => {
    // сделать запрос на сервер о возможностях RTP маршрутизатора
    // посмотреть сервер socket.on('getRtpCapabilities', ...)
    // сервер отправляет обратно объект данных, который содержит rtpCapabilities
    socket.current.emit('getRtpCapabilities', (data) => {
      console.log(`Router RTP Capabilities... ${data.rtpCapabilities}`)

      // мы присваиваем локальную переменную и будем использовать ее, когда
      // загрузка клиентского устройства (см. createDevice)
      rtpCapabilities.current = data.rtpCapabilities
    })
  }

  // Устройство (device) — это конечная точка, подключающаяся к маршрутизатору на
  // серверная часть для отправки/получения мультимедиа
  const createDevice = async () => {
    try {
      device.current = new Device()
      // https://mediasoup.org/documentation/v3/mediasoup-client/api/#device-load
      // Загружает устройство с возможностями RTP маршрутизатора (на стороне сервера)
      await device.current.load({
        // see getRtpCapabilities() below
        routerRtpCapabilities: rtpCapabilities.current,
      })

      console.log('RTP Capabilities', device.current.rtpCapabilities)
    } catch (error) {
      console.log(error)
      if (error.name === 'UnsupportedError')
        console.warn('browser not supported')
    }
  }

  const createSendTransport = () => {
    // see server's socket.on('createWebRtcTransport', sender?, ...)
    // это звонок от продюсера, поэтому sender = true
    socket.current.emit(
      'createWebRtcTransport',
      { sender: true },
      ({ params }) => {
        // Сервер отправляет обратно необходимые параметры
        // для создания Transport на стороне клиента
        if (params.error) {
          console.log(params.error)
          return
        }

        console.log(params)

        // создает новый транспорт WebRTC для отправки мультимедиа
        // на основе параметров транспорта производителя сервера
        // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
        producerTransport.current = device.current.createSendTransport(params)

        // https://mediasoup.org/documentation/v3/communication-between-client-and-server/#producing-media
        // это событие возникает при первом вызове Transport.produce()
        // смотри connectSendTransport() ниже
        producerTransport.current.on(
          'connect',
          async ({ dtlsParameters }, callback, errorBack) => {
            try {
              // передаем локальные параметры DTLS на транспорт на стороне сервера.
              // see server's socket.on('transport-connect', ...)
              await socket.current.emit('transport-connect', {
                dtlsParameters,
              })

              // Сообщите транспорту, что параметры были переданы.
              callback()
            } catch (error) {
              errorBack(error)
            }
          }
        )

        producerTransport.current.on(
          'produce',
          async (parameters, callback, errorBack) => {
            console.log('produce parameters', parameters)

            try {
              // сообщаем серверу, чтобы он создал продюсера
              // со следующими параметрами
              // и ожидаем возврата идентификатора производителя на стороне сервера
              // see server's socket.on('transport-produce', ...)
              await socket.current.emit(
                'transport-produce',
                {
                  kind: parameters.kind,
                  rtpParameters: parameters.rtpParameters,
                  appData: parameters.appData,
                },
                ({ id }) => {
                  // Сообщите транспорту, что параметры были переданы, и сообщите ему
                  // идентификатор производителя на стороне сервера
                  callback({ id })
                }
              )
            } catch (error) {
              errorBack(error)
            }
          }
        )
      }
    )
  }

  const connectSendTransport = async () => {
    // теперь мы вызываем функцию Produce(), чтобы проинструктировать транспорт производителя
    // для отправки мультимедиа на маршрутизатор
    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#transport-produce
    // это действие вызовет события «connect» и «produce», описанные выше
    producer.current = await producerTransport.current.produce(params.current)

    producer.current.on('trackended', () => {
      console.log('track ended')

      // закрыть видеодорожку
    })

    producer.current.on('transportclose', () => {
      console.log('transport ended')

      // закрыть видеодорожку
    })
  }

  const createRecvTransport = async () => {
    // see server's socket.on('consume', sender?, ...)
    // это звонок от Потребителя, поэтому отправитель = false
    await socket.current.emit(
      'createWebRtcTransport',
      { sender: false },
      ({ params }) => {
        // Сервер отправляет обратно необходимые параметры
        // создать Send Transport на стороне клиента
        if (params.error) {
          console.log(params.error)
          return
        }

        console.log(params)

        // создает новый транспорт WebRTC для получения мультимедиа
        // на основе параметров потребительского транспорта сервера
        // https://mediasoup.org/documentation/v3/mediasoup-client/api/#device-createRecvTransport
        consumerTransport.current = device.current.createRecvTransport(params)

        // https://mediasoup.org/documentation/v3/communication-between-client-and-server/#producing-media
        // это событие возникает при первом вызове Transport.produce()
        // смотрим connectRecvTransport() ниже
        consumerTransport.current.on(
          'connect',
          async ({ dtlsParameters }, callback, errorBack) => {
            try {
              // Передавать локальные параметры DTLS на транспорт на стороне сервера.
              // see server's socket.on('transport-recv-connect', ...)
              await socket.current.emit('transport-recv-connect', {
                dtlsParameters,
              })

              // Сообщите транспорту, что параметры были переданы.
              callback()
            } catch (error) {
              // Сообщите транспорту, что что-то не так
              errorBack(error)
            }
          }
        )
      }
    )
  }

  const connectRecvTransport = async () => {
    // для потребителя нам нужно сначала сообщить серверу
    // создать потребителя на основе rtpCapabilities и использовать
    // если маршрутизатор может потреблять, он отправит обратно набор параметров, как показано ниже.
    await socket.current.emit(
      'consume',
      {
        rtpCapabilities: device.current.rtpCapabilities,
      },
      async ({ params }) => {
        if (params.error) {
          console.log('Cannot Consume')
          return
        }

        console.log(params)
        // затем потребляйте на местном потребительском транспорте
        // который создает потребителя
        consumer.current = await consumerTransport.current.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters,
        })

        // деструктурировать и получить видеодорожку от продюсера
        const { track } = consumer.current
        console.log('track: ', track)

        remoteVideo.current.srcObject = new MediaStream([track])

        // потребитель сервера начал работу с приостановленным мультимедиа
        // поэтому нам нужно сообщить серверу о возобновлении
        socket.current.emit('consumer-resume')
      }
    )
  }

  return (
    <div id="video">
      <table>
        <thead>
          <tr>
            <th>Local Video</th>
            <th>Remote Video</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <div id="sharedBtns">
                <video
                  ref={localVideo}
                  id="localVideo"
                  autoPlay
                  className="video"></video>
              </div>
            </td>
            <td>
              <div id="sharedBtns">
                <video
                  ref={remoteVideo}
                  id="remoteVideo"
                  autoPlay
                  className="video"></video>
              </div>
            </td>
          </tr>
          <tr>
            <td>
              <div id="sharedBtns">
                <button id="btnLocalVideo" onClick={getLocalVideo}>
                  1. Get Local Video
                </button>
              </div>
            </td>
          </tr>
          <tr>
            <td>
              <div id="sharedBtns">
                <button id="btnRtpCapabilities" onClick={getRtpCapabilities}>
                  2. Get Rtp Capabilities
                </button>
                <br />
                <button onClick={createDevice} id="btnDevice">
                  3. Create Device
                </button>
              </div>
            </td>
          </tr>
          <tr>
            <td>
              <div id="sharedBtns">
                <button
                  id="btnCreateSendTransport"
                  onClick={createSendTransport}>
                  4. Create Send Transport
                </button>
                <button
                  id="btnConnectSendTransport"
                  onClick={connectSendTransport}>
                  5. Connect Send Transport & Produce
                </button>
              </div>
            </td>
            <td>
              <div id="sharedBtns">
                <button id="btnRecvSendTransport" onClick={createRecvTransport}>
                  6. Create Recv Transport
                </button>
                <br />
                <button
                  id="btnConnectRecvTransport"
                  onClick={connectRecvTransport}>
                  7. Connect Recv Transport & Consume
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

export default App
