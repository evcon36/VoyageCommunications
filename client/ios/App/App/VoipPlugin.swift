import Foundation
import Capacitor

// Мост между VoipCallManager (PushKit/CallKit) и React-частью приложения.
// Регистрируется как чистый Swift-плагин Capacitor 8 — без Objective-C
// мостового файла, через протокол CAPBridgedPlugin.
@objc(VoipPlugin)
public class VoipPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoipPlugin"
    public let jsName = "Voip"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "note", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(onTokenUpdated), name: .voipTokenUpdated, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(onCallAnswered), name: .voipCallAnswered, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(onCallEnded), name: .voipCallEnded, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(onAppActive), name: .voipAppActive, object: nil)
        VoipCallManager.shared.log("веб-слой загрузился")
    }

    // Пока телефон заблокирован, приложение показано поверх экрана блокировки,
    // но остаётся неактивным: камеру и микрофон система в этот момент не даёт,
    // и входить в комнату бесполезно. Веб-слой спрашивает об этом перед входом.
    @objc func getState(_ call: CAPPluginCall) {
        call.resolve(["active": VoipCallManager.shared.isActive])
    }

    // Веб-слой пишет в тот же дневник, что и нативная часть. Без этого в
    // разборе звонка видна только половина пути.
    @objc func note(_ call: CAPPluginCall) {
        VoipCallManager.shared.log("веб: " + (call.getString("text") ?? "?"))
        call.resolve()
    }

    // JS опрашивает это с повторами: PushKit отдаёт токен вскоре после старта
    // приложения, и первый запрос может прийти раньше, чем токен появился.
    @objc func getToken(_ call: CAPPluginCall) {
        if let token = VoipCallManager.shared.deviceTokenHex {
            call.resolve(["token": token])
        } else {
            call.resolve([:])
        }
    }

    @objc func endCall(_ call: CAPPluginCall) {
        if let callId = call.getString("callId") {
            VoipCallManager.shared.endCall(callId: callId)
        }
        call.resolve()
    }

    // React дёргает это один раз при старте — если приложение было разбужено
    // пушем и звонок уже приняли/сбросили с экрана блокировки до того, как
    // JS вообще успел загрузиться.
    @objc func getPendingCall(_ call: CAPPluginCall) {
        call.resolve(VoipCallManager.shared.takePendingCall() ?? [:])
    }

    // Запрос к серверу системной сетью. Веб-слой зовёт это вместо fetch:
    // его собственный сетевой движок до сервера доходит не всегда, а этот —
    // тот же, которым пользуется весь остальной телефон.
    @objc func request(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"), let url = URL(string: urlStr) else {
            call.reject("нет адреса"); return
        }
        var req = URLRequest(url: url)
        req.httpMethod = call.getString("method") ?? "GET"
        // Короткий срок на попытку — намеренно. Смысл не в терпении, а в
        // быстрой смене соединения: рукопожатие либо проходит сразу, либо
        // не пройдёт вовсе (см. perform).
        req.timeoutInterval = call.getDouble("timeout") ?? 3
        req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        if let headers = call.getObject("headers") {
            for (key, value) in headers {
                if let text = value as? String { req.setValue(text, forHTTPHeaderField: key) }
            }
        }
        if let body = call.getString("body") { req.httpBody = body.data(using: .utf8) }
        let attempts = max(1, min(20, call.getInt("attempts") ?? 12))
        VoipCallManager.shared.perform(req, attemptsLeft: attempts) { status, text, error in
            if let error = error { call.reject(error); return }
            call.resolve(["status": status, "body": text])
        }
    }

    @objc private func onTokenUpdated(_ note: Notification) {
        notifyListeners("tokenUpdated", data: note.userInfo as? [String: Any] ?? [:])
    }

    @objc private func onCallAnswered(_ note: Notification) {
        notifyListeners("callAnswered", data: note.userInfo as? [String: Any] ?? [:])
    }

    @objc private func onCallEnded(_ note: Notification) {
        notifyListeners("callEnded", data: note.userInfo as? [String: Any] ?? [:])
    }

    @objc private func onAppActive(_ note: Notification) {
        notifyListeners("appActive", data: [:])
    }
}
