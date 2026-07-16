import SwiftUI
import CoreImage.CIFilterBuiltins

/// QR code + copyable deep link for pairing the iOS app with this bridge.
struct PairingQRView: View {
    @EnvironmentObject var bridge: BridgeManager

    var body: some View {
        VStack(spacing: 8) {
            if let payload = bridge.pairingURL(), let image = Self.qrImage(for: payload) {
                Image(nsImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 180, height: 180)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                Text("Scan with the AgentDeck iOS app,\nor open the link on the phone:")
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
