import { Agent, ProxyAgent, buildConnector, setGlobalDispatcher } from "undici";

export function configureProxy() {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;

  if (proxy) {
    setGlobalDispatcher(new ProxyAgent(proxy));
    console.log(`Using proxy: ${proxy}`);
    return;
  }

  const connector = buildConnector({ family: 4 });
  setGlobalDispatcher(new Agent({ connect: connector }));
}
