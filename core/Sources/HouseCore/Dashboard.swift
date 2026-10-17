import Foundation

/// The panel's dashboard: `dashboard.json` in the data folder. It lays out Home Assistant
/// controls the floor plan has no device for (a fan, an infrared AC, media players, a status
/// row) beside the plan's lights. The entities it names are all the panel may read or call.
/// The Mac reads it from its data folder and hands it to paired iPhones and iPads with the plan.
public struct Dashboard {
    public let config: [String: Any]
    public let entities: Set<String>
    /// The web addresses the file links to: all the panel may open.
    public let urls: Set<String>
    /// The file as read, to pass on (sync) or compare.
    public let data: Data

    /// Domains an entity id in the file may belong to; anything else (a plan light id such as
    /// `sala.luz`) is not a Home Assistant entity.
    private static let domains: Set<String> = [
        "script", "switch", "light", "fan", "climate", "media_player", "sensor", "binary_sensor", "device_tracker",
        "input_boolean", "input_select", "input_number", "select", "number", "button", "sun", "vacuum",
    ]

    public static func url(in directory: URL) -> URL { directory.appendingPathComponent("dashboard.json") }

    public init?(directory: URL) {
        guard let data = try? Data(contentsOf: Self.url(in: directory)) else { return nil }
        self.init(data: data)
    }

    public init?(data: Data) {
        guard let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        self.config = config
        self.data = data
        var found = Set<String>()
        var links = Set<String>()
        func collect(_ value: Any) {
            if let text = value as? String {
                if Self.isEntity(text) { found.insert(text) }
                if text.hasPrefix("http://") || text.hasPrefix("https://") { links.insert(text) }
            } else if let list = value as? [Any] { list.forEach(collect) }
            else if let object = value as? [String: Any] { object.values.forEach(collect) }
        }
        collect(config)
        entities = found
        urls = links
    }

    private static func isEntity(_ text: String) -> Bool {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 2 && domains.contains(String(parts[0])) && !parts[1].isEmpty
            && parts[1].allSatisfy { $0.isLowercase || $0.isNumber || $0 == "_" }
    }

    /// One entity of the dashboard, by a service of its own domain, or a dashboard script
    /// run directly with its fields (`script.ar_escritorio` with `temperatura`…).
    public func allows(domain: String, service: String, data: [String: Any]) -> Bool {
        if let target = data["entity_id"] as? String {
            return entities.contains(target) && target.hasPrefix(domain + ".")
        }
        return domain == "script" && entities.contains("script.\(service)")
    }

    /// `"menuBar": "<sensor>"`: a temperature shown beside the menu bar icon, always.
    public var menuBarEntity: String? { config["menuBar"] as? String }

    /// The menu bar panel, grown to fit the dashboard: `"panel": {"width": …, "height": …}`.
    public var panelSize: CGSize {
        let panel = config["panel"] as? [String: Any] ?? [:]
        let width = (panel["width"] as? Double).map { min(max($0, 440), 680) } ?? 520
        let height = (panel["height"] as? Double).map { min(max($0, 600), 1000) } ?? 800
        return CGSize(width: width, height: height)
    }
}
