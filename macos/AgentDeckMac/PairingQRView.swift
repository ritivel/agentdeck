import SwiftUI
import CoreImage.CIFilterBuiltins

/// QR code + copyable link for pairing a phone with this bridge.
/// Defaults to the web-app URL (any phone camera → browser, nothing to
/// install); the iOS-app deep link is one segment away.
struct PairingQRView: View {
    @EnvironmentObject var bridge: BridgeManager

    private enum Target: String, CaseIterable, Identifiable {
        case web = "Any phone"
        case app = "iOS app"
        var id: String { rawValue }
    }

    @State private var target: Target = .web

    private var payload: String? {
        target == .web ? bridge.webPairingURL() : bridge.pairingURL()
    }

    var body: some View {
        VStack(spacing: 8) {
            Picker("", selection: $target) {
                ForEach(Target.allCases) { t in Text(t.rawValue).tag(t) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            if let payload, let image = Self.qrImage(for: payload) {
                Image(nsImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 180, height: 180)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                Text(target == .web
                     ? "Scan with your phone's camera —\nAgentDeck opens in the browser. Nothing to install."
                     : "Scan with the AgentDeck iOS app,\nor open the link on the phone:")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button {
                    copyToPasteboard(payload)
                } label: {
                    Label("Copy Pairing Link", systemImage: "doc.on.doc")
                        .font(.caption)
                }
            } else {
                Text("Pairing info unavailable — is the bridge running and the Mac on a network?")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
    }

    static func qrImage(for string: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}
