# Auk for Homey

Homey app for the Auk Mini 2 indoor garden, talking to it locally over Bluetooth LE.

## Layout

- `lib/protocol.ts` — line protocol: codes, framing, wall-clock timestamps, daily-cycle maths
- `lib/AukSession.ts` — request/response over one open link
- `lib/AukController.ts` — connection lifecycle: reconnect with backoff, 5-minute poll, hourly clock sync
- `lib/HomeyBleTransport.ts` — Homey BLE adapter
- `drivers/mini2` — capabilities and Flow cards
- `test/fakeAuk.ts` — simulated device used by the tests

## Development

```sh
npm install
npm run validate   # lint + tests + homey app validate
npm start          # homey app run --remote
```

## Acknowledgements

The BLE protocol was reverse-engineered and published by
[xraysight/aukctl](https://github.com/xraysight/aukctl) (MIT).
