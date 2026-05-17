import asyncio
import websockets
import json
import time

async def test():
    try:
        async with websockets.connect('ws://127.0.0.1:7070') as ws:
            print('Connected to bridge WebSocket!')
            count = 0
            start = time.time()
            while time.time() - start < 3:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    data = json.loads(msg)
                    count += 1
                    if count <= 5:
                        x = data['x']
                        y = data['y']
                        v = data['valid']
                        print(f'  Sample {count}: x={x:.3f} y={y:.3f} valid={v}')
                except asyncio.TimeoutError:
                    pass
            print(f'Total samples received in 3s: {count}')
    except Exception as e:
        print(f'ERROR connecting to bridge: {e}')

asyncio.run(test())
