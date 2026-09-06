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
    ]

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(onTokenUpdated), name: .voipTokenUpdated, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(onCallAnswered), name: .voipCallAnswered, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(onCallEnded), name: .voipCallEnded, object: nil)
    }

    @objc func getToken(_ call: CAPPluginCall) {
        call.resolve(["token": VoipCallManager.shared.deviceTokenHex as Any])
    }

    // React дёргает это один раз при старте — если приложение было разбужено
    // пушем и звонок уже приняли/сбросили с экрана блокировки до того, как
    // JS вообще успел загрузиться.
    @objc func getPendingCall(_ call: CAPPluginCall) {
        call.resolve(VoipCallManager.shared.takePendingCall() ?? [:])
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
}
