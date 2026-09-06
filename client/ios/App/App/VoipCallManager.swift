import Foundation
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

    // JS может ещё не быть готов (приложение только что разбудили пушем) —
    // кладём событие сюда, плагин отдаст его, как только React смонтируется
    // и спросит через getPendingCall().
    private var pendingCall: [String: Any]?

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    func setup() {
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
    }

    // Забирает и очищает то, что накопилось, пока JS не был готов слушать.
    func takePendingCall() -> [String: Any]? {
        defer { pendingCall = nil }
        return pendingCall
    }

    private func post(_ name: Notification.Name, _ payload: [String: Any]) {
        NotificationCenter.default.post(name: name, object: nil, userInfo: payload)
    }
}

extension VoipCallManager: PKPushRegistryDelegate {
    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let hex = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        deviceTokenHex = hex
        post(.voipTokenUpdated, ["token": hex])
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        deviceTokenHex = nil
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        guard type == .voIP else { return completion() }
        let data = payload.dictionaryPayload

        let callId = data["callId"] as? String ?? UUID().uuidString
        let fromName = data["fromName"] as? String ?? "Voyage Coms"

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

        provider.reportNewIncomingCall(with: uuid, update: update) { error in
            if let error = error {
                print("VoipCallManager: reportNewIncomingCall error", error.localizedDescription)
            }
            completion()
        }
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType) {
        // Старая сигнатура без completion — на всякий случай, если система её дёрнет.
        self.pushRegistry(registry, didReceiveIncomingPushWith: payload, for: type, completion: {})
    }
}

// uuid (для CallKit) -> callId (наш, серверный)
private var callUUIDs: [UUID: String] = [:]

extension VoipCallManager: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        callUUIDs.removeAll()
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let callId = callUUIDs[action.callUUID] else { return action.fail() }
        pendingCall = ["type": "answered", "callId": callId]
        post(.voipCallAnswered, ["callId": callId])
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        guard let callId = callUUIDs[action.callUUID] else { return action.fail() }
        callUUIDs.removeValue(forKey: action.callUUID)
        pendingCall = ["type": "ended", "callId": callId]
        post(.voipCallEnded, ["callId": callId])
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // Аудио самого звонка ведёт WebRTC внутри WKWebView (через net.js/LiveKit),
        // не нативный слой — здесь ничего активировать дополнительно не нужно.
    }
}

extension Notification.Name {
    static let voipTokenUpdated = Notification.Name("voipTokenUpdated")
    static let voipCallAnswered = Notification.Name("voipCallAnswered")
    static let voipCallEnded = Notification.Name("voipCallEnded")
}
