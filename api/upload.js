const STORE_KEY = "proxypin:captures";

async function redis(command) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
        throw new Error("Falta configurar Upstash Redis");
    }

    const response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(command)
    });

    const result = await response.json();

    if (!response.ok || result.error) {
        throw new Error("Error de almacenamiento");
    }

    return result.result;
}

function sanitize(value) {
    const blocked = /cookie|authorization|password|passwd|secret|token|credential|api.?key/i;

    if (Array.isArray(value)) {
        return value.map(sanitize);
    }

    if (value && typeof value === "object") {
        const output = {};

        for (const [key, item] of Object.entries(value)) {
            if (blocked.test(key)) continue;
            output[key] = sanitize(item);
        }

        return output;
    }

    if (typeof value === "string" && value.length > 100000) {
        return "[Contenido omitido: demasiado grande]";
    }

    return value;
}

module.exports = async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "POST") {
        const expected = process.env.UPLOAD_KEY;

        if (!expected || req.headers["x-upload-key"] !== expected) {
            return res.status(401).json({
                error: "No autorizado"
            });
        }

        try {
            const body = req.body;

            if (!body || typeof body !== "object" || Array.isArray(body)) {
                return res.status(400).json({
                    error: "Se esperaba un objeto JSON"
                });
            }

            const capture = sanitize({
                id: Date.now().toString() + "-" +
                    Math.random().toString(36).slice(2, 8),
                receivedAt: new Date().toISOString(),
                ...body
            });

            const serialized = JSON.stringify(capture);

            if (serialized.length > 150000) {
                return res.status(413).json({
                    error: "Captura demasiado grande"
                });
            }

            await redis(["LPUSH", STORE_KEY, serialized]);
            await redis(["LTRIM", STORE_KEY, "0", "49"]);

            return res.status(201).json({
                ok: true,
                id: capture.id
            });
        } catch (error) {
            console.error("Upload error:", error.message);

            return res.status(500).json({
                error: "No se pudo guardar la captura"
            });
        }
    }

    if (req.method === "GET") {
        try {
            const records = await redis([
                "LRANGE",
                STORE_KEY,
                "0",
                "49"
            ]);

            const captures = (records || []).map(item => {
                try {
                    return JSON.parse(item);
                } catch (_) {
                    return null;
                }
            }).filter(Boolean);

            return res.status(200).json({
                captures: captures
            });
        } catch (error) {
            console.error("Read error:", error.message);

            return res.status(500).json({
                error: "No se pudieron cargar las capturas"
            });
        }
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({
        error: "Método no permitido"
    });
};
