EA realtime dashboard + daily JSON storage for Railway

1) Deploy folder này lên Railway.
2) Add ENV:
   EA_TOKEN=your_ea_token
   ADMIN_PIN=07072000
   HEARTBEAT_STALE_SEC=10
3) Start command: npm start
4) Trong EA:
   BridgeURL=https://ten-app.railway.app
   BridgeEaToken=your_ea_token
   EnableZeroDelayBridge=true
   EnableRemoteControl=true
5) Mỗi heartbeat sẽ tạo/cập nhật file:
   data/daily/TENBOT_DDMMYYYY.json
   Ví dụ: data/daily/cua2k_16042026.json
6) Web giao diện đọc lại file ngày hiện tại qua API:
   /api/overview
   /api/file/<filename>
7) Remote command từ web:
   close_all, close_buy, close_sell, close_loss, time_on, time_off
