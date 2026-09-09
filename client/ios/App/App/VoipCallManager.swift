import Foundation
import UIKit
import PushKit
import CallKit
import AVFoundation

// Централизованный обработчик VoIP-пушей и CallKit. AppDelegate заводит его
// сразу при старте (не лениво): PushKit может разбудить приложение ещё до
// того, как пользователь его открыл, и слушатель должен быть готов заранее.
//
// Важное правило Apple: каждый VoIP-пуш ОБЯЗАН немедленно и синхронно
// репортиться в CallKit через reportNewIncomingCall. Если этого не делать —
// система через несколько нарушений подряд просто перестаёт будить
// приложение пушами вообще.
final class VoipCallManager: NSObject {
    static let shared = VoipCallManager()

    private let registry = PKPushRegistry(queue: .main)
    private let provider: CXProvider

    private(set) var deviceTokenHex: String?

    // Тишина, которую мы играем, пока звонок принят, а разговора ещё нет.
    // Зачем — см. startKeepAlive().
    private let engine = AVAudioEngine()
    private let silence = AVAudioPlayerNode()

    // JS может ещё не быть готов (приложение только что разбудили пушем) —
    // кладём решение сюда, плагин отдаст его, как только React смонтируется
    // и спросит через getPendingCall(). Хранится на диске, а не в памяти:
    // при заблокированном экране система может выгрузить приложение сразу
    // после ответа, и решение, оставшееся в памяти, пропало бы вместе с ним.
    private let pendingKey = "voip.pendingCall"
    private var pendingCall: [String: Any]? {
        get { UserDefaults.standard.dictionary(forKey: pendingKey) }
        set {
            if let value = newValue { UserDefaults.standard.set(value, forKey: pendingKey) }
            else { UserDefaults.standard.removeObject(forKey: pendingKey) }
        }
    }

    override init() {
        // Имя и иконка — единственный способ вернуться в приложение с
        // системного экрана звонка. Без iconTemplateImageData кнопки
        // приложения там нет вовсе, и человек, ответивший с рабочего стола,
        // остаётся на системном экране без входа в разговор.
        let config = CXProviderConfiguration(localizedName: "Voyage Coms")
        config.supportsVideo = true
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        if let icon = UIImage(named: "CallKitIcon") {
            config.iconTemplateImageData = icon.pngData()
        }
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    func setup() {
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        log("старт", "состояние \(appStateName())")
        NotificationCenter.default.addObserver(
            self, selector: #selector(onDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification, object: nil)
        scheduleDebugCallIfRequested()
    }

    // ── Дневник звонка ────────────────────────────────────────────────────
    //
    // На заблокированном экране веб-слой спит и рассказать о себе не может:
    // всё, что мы знаем о таком звонке, приходит только отсюда. Без этого
    // «сбой вызова» неотличим от «приложение не проснулось» и от
    // «проснулось, но не успело войти в комнату».
    //
    // Пишем на диск сразу, отправляем следом: если приложение убьют, записи
    // переживут смерть и уедут при следующем запуске.
    private let logKey = "voip.log"

    // Отправка не сразу, а пачкой. Каждое событие отдельным запросом — это
    // сорок с лишним запросов в минуту на живом звонке, а путь /auth/ на
    // сервере ограничен тридцатью. Дневник выедал лимит и ронял в 429
    // соседей по пути — в том числе регистрацию пуш-токена, без которой
    // звонки в закрытое приложение не доходят вовсе. Дневник обязан быть
    // незаметным: он служебный и не вправе мешать работе.
    private var flushScheduled = false
    private var flushing = false
    private var pauseUntil: Date?

    func log(_ name: String, _ detail: String = "") {
        let stamp = ISO8601DateFormatter().string(from: Date())
        var events = UserDefaults.standard.array(forKey: logKey) as? [[String: String]] ?? []
        events.append(["at": stamp, "name": name, "detail": detail])
        if events.count > 40 { events.removeFirst(events.count - 40) }
        UserDefaults.standard.set(events, forKey: logKey)
        print("VOIP: \(name) \(detail)")
        scheduleFlush()
    }

    private func scheduleFlush() {
        guard !flushScheduled else { return }
        flushScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            self?.flushScheduled = false
            self?.flushLog()
        }
    }

    // Входы те же, что у веб-слоя, и по той же причине: ни один не работает у
    // всех. Первый — единственный, который доходит на мобильном интернете в
    // России, остальные выручают, когда с ним беда. Мы уже теряли записи
    // молча, когда у главного входа кончился сертификат.
    private let logOrigins = [
        "https://voyage-community.ru",
        "https://voyage-coms.ru",
        "https://communications.voyage-community.ru",
    ]

    private func flushLog() {
        guard let token = deviceTokenHex else { return }   // без токена сервер нас не опознает
        // Одна отправка за раз: иначе параллельные заходы шлют одни и те же
        // записи по нескольку раз, и в логах двоится то, чего не было.
        guard !flushing else { return }
        if let until = pauseUntil, until > Date() { return }
        let events = UserDefaults.standard.array(forKey: logKey) as? [[String: String]] ?? []
        guard !events.isEmpty else { return }
        guard let body = try? JSONSerialization.data(withJSONObject: ["token": token, "events": events])
        else { return }
        flushing = true
        send(body, sent: events.count, origins: logOrigins[...])
    }

    private func send(_ body: Data, sent: Int, origins: ArraySlice<String>) {
        guard let origin = origins.first,
              let url = URL(string: origin + "/auth/voip-log") else { flushing = false; return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        req.timeoutInterval = 8
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            guard let self = self else { return }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            // Чистим только то, что сервер точно принял: иначе при обрыве
            // связи записи пропадут, а они и нужны как раз в такие моменты.
            if code == 200 {
                self.flushing = false
                let left = UserDefaults.standard.array(forKey: self.logKey) as? [[String: String]] ?? []
                UserDefaults.standard.set(Array(left.dropFirst(sent)), forKey: self.logKey)
                return
            }
            // 429 — мы сами перебрали лимит. Идти с этим на другие входы
            // нельзя: там тот же сервер и тот же счётчик. Молчим минуту.
            if code == 429 {
                self.flushing = false
                self.pauseUntil = Date().addingTimeInterval(60)
                return
            }
            if origins.count > 1 {
                self.send(body, sent: sent, origins: origins.dropFirst())
            } else {
                self.flushing = false   // записи остались на диске, уйдут позже
            }
        }.resume()
    }

    private func appStateName() -> String {
        switch UIApplication.shared.applicationState {
        case .active: return "активно"
        case .inactive: return "неактивно"        // в том числе поверх заблокированного экрана
        case .background: return "в фоне"
        @unknown default: return "неизвестно"
        }
    }

    // Пока телефон заблокирован, приложение поверх экрана блокировки живёт в
    // состоянии «неактивно» и становится активным только после разблокировки.
    // Веб-слою это нужно знать: входить в комнату до разблокировки бесполезно,
    // камеру и микрофон система в этот момент не отдаёт.
    var isActive: Bool { UIApplication.shared.applicationState == .active }

    @objc private func onDidBecomeActive() {
        log("телефон разблокирован")
        post(.voipAppActive, [:])
    }

    // Забирает и очищает то, что накопилось, пока JS не был готов слушать.
    func takePendingCall() -> [String: Any]? {
        defer { pendingCall = nil }
        return pendingCall
    }

    // Гасит системный экран звонка, когда звонок закончился не через него:
    // ответили в самом приложении, звонящий отменил, истёк таймаут. Без этого
    // на телефоне остаётся висеть «активный» звонок, которого уже нет.
    func endCall(callId: String) {
        guard let uuid = uuidByCallId[callId] else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
        uuidByCallId.removeValue(forKey: callId)
        callUUIDs.removeValue(forKey: uuid)
        stopKeepAlive()
    }

    private func post(_ name: Notification.Name, _ payload: [String: Any]) {
        NotificationCenter.default.post(name: name, object: nil, userInfo: payload)
    }

    // Категорию и режим объявляем сами, включает сессию потом система
    // (didActivate). Своими руками включать нельзя: CallKit ведёт звук сам.
    private func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .voiceChat,
                                    options: [.allowBluetooth, .defaultToSpeaker])
        } catch {
            log("аудиосессия не настроилась", error.localizedDescription)
        }
    }

    // Между «ответил» и «разговор пошёл» у нас провал в несколько секунд, а на
    // заблокированном экране — до самой разблокировки: разговор ведёт WebRTC
    // внутри веб-слоя, а тот в это время спит. Для системы такой звонок
    // выглядит как принятый, но молчащий и ничем не занятый, и она вправе
    // усыпить приложение и закрыть вызов — это и видно как «сбой вызова».
    //
    // Поэтому с момента ответа и до входа в комнату играем тишину: звонок
    // становится настоящим звонком с живым звуком, и система его не трогает.
    private func startKeepAlive() {
        guard !engine.isRunning else { return }
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48000)
        else { return }
        buffer.frameLength = buffer.frameCapacity      // нули — это и есть тишина
        engine.attach(silence)
        engine.connect(silence, to: engine.mainMixerNode, format: format)
        do {
            try engine.start()
            silence.scheduleBuffer(buffer, at: nil, options: .loops)
            silence.play()
            log("держим звонок")
        } catch {
            log("держать звонок не вышло", error.localizedDescription)
        }
    }

    private func stopKeepAlive() {
        guard engine.isRunning else { return }
        silence.stop()
        engine.stop()
        engine.detach(silence)
    }

    // Стенд для отладки: настоящих VoIP-пушей симулятор не получает, поэтому
    // входящий звонок нужно уметь показать самим. Запускается только с
    // аргументом -voipDebugCallDelay N и только в отладочной сборке, в
    // TestFlight и App Store этого кода нет вовсе.
    private func scheduleDebugCallIfRequested() {
        #if DEBUG
        let delay = UserDefaults.standard.integer(forKey: "voipDebugCallDelay")
        guard delay > 0 else { return }
        // Свёрнутое приложение система усыпляет, и обычный таймер до срока не
        // доживает. Просим у неё отсрочку — её хватает, чтобы дождаться.
        var task = UIBackgroundTaskIdentifier.invalid
        task = UIApplication.shared.beginBackgroundTask(withName: "voipDebugCall") {
            UIApplication.shared.endBackgroundTask(task)
            task = .invalid
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(delay)) { [weak self] in
            self?.reportIncoming(callId: "debug-\(UUID().uuidString.prefix(8))",
                                 fromName: "Отладочный звонок") {}
            if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
        }
        #endif
    }

    // Показ входящего звонка системе. Вынесено из обработчика пуша: этим же
    // путём звонок показывает отладочный стенд.
    func reportIncoming(callId: String, fromName: String, completion: @escaping () -> Void) {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: fromName)
        update.localizedCallerName = fromName
        update.hasVideo = true
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false

        let uuid = UUID()
        callUUIDs[uuid] = callId
        uuidByCallId[callId] = uuid

        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if let error = error {
                self?.log("показать звонок не вышло", error.localizedDescription)
            } else {
                self?.log("звонок показан", "\(callId), состояние \(self?.appStateName() ?? "?")")
            }
            completion()
        }
    }
}

extension VoipCallManager: PKPushRegistryDelegate {
    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let hex = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        deviceTokenHex = hex
        post(.voipTokenUpdated, ["token": hex])
        flushLog()   // токен появился — теперь есть чем представиться серверу
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        deviceTokenHex = nil
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        guard type == .voIP else { return completion() }
        let data = payload.dictionaryPayload

        let callId = data["callId"] as? String ?? UUID().uuidString
        let fromName = data["fromName"] as? String ?? "Voyage Coms"
        log("пуш пришёл", "\(callId), состояние \(appStateName())")
        reportIncoming(callId: callId, fromName: fromName, completion: completion)
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType) {
        // Старая сигнатура без completion — на всякий случай, если система её дёрнет.
        self.pushRegistry(registry, didReceiveIncomingPushWith: payload, for: type, completion: {})
    }
}

// uuid (для CallKit) -> callId (наш, серверный) и обратно
private var callUUIDs: [UUID: String] = [:]
private var uuidByCallId: [String: UUID] = [:]

extension VoipCallManager: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        log("система сбросила звонки")
        callUUIDs.removeAll()
        uuidByCallId.removeAll()
        stopKeepAlive()
    }

    // Если приложение успело выгрузиться между пушем и ответом, связь с
    // нашим номером звонка теряется. Раньше в этом случае действие
    // отклонялось и телефон показывал «сбой вызова». Теперь отвечаем всё
    // равно, с пустым номером: веб-слой примет тот звонок, который ему
    // придёт от сервера.
    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        let callId = callUUIDs[action.callUUID] ?? ""
        // Звук звонка нужно объявить системе прямо здесь, до подтверждения
        // ответа. Без этого при заблокированном экране iOS считает вызов
        // несостоявшимся и показывает «сбой вызова»: приложение ответило,
        // но разговором так и не занялось.
        configureAudioSession()
        log("ответили", "\(callId.isEmpty ? "номер потерян" : callId), состояние \(appStateName())")
        pendingCall = ["type": "answered", "callId": callId]
        post(.voipCallAnswered, ["callId": callId])
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let callId = callUUIDs[action.callUUID] ?? ""
        log("звонок завершён системой", "\(callId), состояние \(appStateName())")
        callUUIDs.removeValue(forKey: action.callUUID)
        if !callId.isEmpty { uuidByCallId.removeValue(forKey: callId) }
        pendingCall = ["type": "ended", "callId": callId]
        post(.voipCallEnded, ["callId": callId])
        stopKeepAlive()
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // Разговор ведёт WebRTC внутри веб-слоя, но до него дело дойдёт не
        // сразу, а на заблокированном экране — только после разблокировки.
        // До тех пор звонок держим тишиной, иначе система его закроет.
        log("система включила звук")
        startKeepAlive()
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        stopKeepAlive()
    }
}

extension Notification.Name {
    static let voipTokenUpdated = Notification.Name("voipTokenUpdated")
    static let voipCallAnswered = Notification.Name("voipCallAnswered")
    static let voipCallEnded = Notification.Name("voipCallEnded")
    static let voipAppActive = Notification.Name("voipAppActive")
}
