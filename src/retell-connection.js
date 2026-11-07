// v3 returns connection details, not a stored call object. Keep the provider's
// transport and ICE configuration together; SDK 3 otherwise defaults to LiveKit.
export function retellConnection(call) {
  if (!call || typeof call.call_id !== 'string' || !call.call_id.trim() ||
      typeof call.access_token !== 'string' || !call.access_token.trim() ||
      !['gateway', 'livekit'].includes(call.transport) || !Array.isArray(call.ice_servers) ||
      call.ice_servers.some((server) => !server ||
        !(typeof server.urls === 'string' && server.urls.trim() ||
          Array.isArray(server.urls) && server.urls.length && server.urls.every((url) => typeof url === 'string' && url.trim())))) {
    throw new Error('Voice setup returned incomplete connection details. Use text practice.');
  }
  return { callId: call.call_id, accessToken: call.access_token,
    transport: call.transport, iceServers: call.ice_servers };
}
