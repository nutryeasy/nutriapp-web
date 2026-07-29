/**
 * /api/enviar-recordatorios
 *
 * Esta función NO se ejecuta sola dentro de Vercel (el plan gratis solo
 * permite tareas programadas una vez al día). En vez de eso, un servicio
 * externo gratuito (cron-job.org) la "toca" cada 15 minutos por HTTP.
 *
 * Variables de entorno necesarias en Vercel (Settings → Environment Variables):
 *   SUPABASE_URL              — la misma URL que ya usa la app
 *   SUPABASE_SERVICE_KEY      — la "service_role key" de Supabase (Settings → API).
 *                                 OJO: es distinta a la "anon key" que usa el navegador,
 *                                 esta sí tiene permisos completos y NUNCA debe estar en el código
 *                                 del frontend — por eso vive aquí, del lado del servidor.
 *   WHATSAPP_TOKEN             — token de acceso de tu app de Meta (WhatsApp Cloud API)
 *   WHATSAPP_PHONE_NUMBER_ID   — el "Phone number ID" de tu número de WhatsApp Business
 *   WHATSAPP_TEMPLATE_NAME     — el nombre exacto de tu plantilla aprobada por Meta
 *   CRON_SECRET                — cualquier texto largo que tú inventes, para que nadie más
 *                                 pueda llamar a esta URL y disparar mensajes en tu nombre
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || "recordatorio_cita";
const CRON_SECRET = process.env.CRON_SECRET;

async function sbGet(key) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/kv_store?key=eq.${encodeURIComponent(key)}&select=value`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data && data[0] ? JSON.parse(data[0].value) : null;
}

async function sbSet(key, value) {
  await fetch(`${SUPABASE_URL}/rest/v1/kv_store?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }),
  });
}

/** Lista todas las llaves que empiecen con cierto prefijo (ej. "patients:") */
async function sbListKeys(prefix) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/kv_store?key=like.${encodeURIComponent(prefix)}*&select=key`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) return [];
  const data = await r.json();
  return (data || []).map((d) => d.key);
}

function interpolar(texto, vars) {
  return (texto || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ""));
}

/**
 * Envía un mensaje de plantilla por WhatsApp Cloud API.
 * IMPORTANTE: ajusta el arreglo "components" para que coincida EXACTAMENTE
 * con las variables de tu plantilla aprobada en Meta (el número y orden de
 * {{1}}, {{2}}, etc. debe coincidir con lo que registraste).
 */
async function enviarWhatsApp(telefonoDigitos, mensajeCompleto) {
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to: `52${telefonoDigitos}`, // ajusta el código de país si tu consultorio no es de México
    type: "template",
    template: {
      name: WHATSAPP_TEMPLATE_NAME,
      language: { code: "es_MX" },
      components: [
        { type: "body", parameters: [{ type: "text", text: mensajeCompleto }] },
      ],
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

export default async function handler(req, res) {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    return res.status(401).json({ error: "No autorizado" });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: "Falta configurar SUPABASE_URL / SUPABASE_SERVICE_KEY en Vercel" });
  }

  const resultados = [];
  const errores = [];

  try {
    const llavesPacientes = await sbListKeys("patients:");
    const users = (await sbGet("users")) || {};

    for (const llave of llavesPacientes) {
      const nutriUsername = llave.replace("patients:", "");
      const reglas = (await sbGet(`reglasRecordatorio:${nutriUsername}`)) || [];
      const activas = reglas.filter((r) => r.activo && r.disparador === "antes_cita" && r.horasAntes);
      if (activas.length === 0) continue;

      const citas = (await sbGet(`citas:${nutriUsername}`)) || [];
      const nutri = users[nutriUsername];

      for (const cita of citas) {
        if (cita.estado === "cancelada" || !cita.fecha || !cita.hora) continue;
        const fechaHoraCita = new Date(`${cita.fecha}T${cita.hora}:00`);
        if (isNaN(fechaHoraCita.getTime())) continue;

        for (const regla of activas) {
          const objetivo = new Date(fechaHoraCita.getTime() - Number(regla.horasAntes) * 60 * 60 * 1000);
          const diffMin = Math.abs((Date.now() - objetivo.getTime()) / 60000);
          if (diffMin > 15) continue; // fuera de la ventana de esta corrida (cron cada 15 min)

          const dedupeKey = `recordatorioEnviado:${nutriUsername}:${cita.id}:${regla.id}`;
          const yaEnviado = await sbGet(dedupeKey);
          if (yaEnviado) continue;

          const mensaje = interpolar(regla.mensaje, {
            nombre: (cita.patientName || "").split(" ")[0],
            fecha: cita.fecha,
            hora: cita.hora,
            nutriologo: nutri?.name || "",
          });

          const envio = await enviarWhatsApp(cita.patientUsername, mensaje);
          if (envio.ok) {
            await sbSet(dedupeKey, { enviado: true, fecha: new Date().toISOString() });
            resultados.push({ paciente: cita.patientName, regla: regla.nombre, cita: `${cita.fecha} ${cita.hora}` });
          } else {
            errores.push({ paciente: cita.patientName, regla: regla.nombre, error: envio.data });
          }
        }
      }
    }

    return res.status(200).json({ ok: true, enviados: resultados.length, resultados, errores });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
