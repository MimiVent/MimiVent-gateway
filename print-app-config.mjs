import { certificateFingerprint, printSetupArtifacts } from './app_setup.mjs';

const required = (key) => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
};
const port = Number(process.env.PORT ?? '8444');
const mqttPort = Number(process.env.MQTT_EXTERNAL_PORT ?? '1883');
const certificatePath = required('TLS_CERT_FILE');
await printSetupArtifacts({
  host: required('NAS_IP'),
  gatewayPort: port,
  certificatePin: certificateFingerprint(certificatePath),
  mqttPort,
  mqttUsername: required('MQTT_USERNAME'),
  mqttPassword: required('MQTT_PASSWORD'),
});
