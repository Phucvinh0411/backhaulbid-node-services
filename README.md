# ⚡ BackHaulBid Bidding Service

> **Dịch Vụ Đấu Giá Ngược Thời Gian Thực (NestJS + MongoDB + WebSockets + RabbitMQ)**
>
> BackHaulBid Node Services là monorepo NestJS gồm bidding-service và notification-service. Bidding-service quản lý phiên đấu giá, nhận giá từ nhà xe qua REST/WebSocket, lưu lịch sử giá và phát sự kiện qua RabbitMQ.

---

## 🛠️ Công Nghệ Sử Dụng (Tech Stack)

*   **Framework**: ![NestJS](https://img.shields.io/badge/NestJS-E0234E?style=flat-square&logo=nestjs&logoColor=white)
*   **Database**: ![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=flat-square&logo=mongodb&logoColor=white) (sử dụng Mongoose)
*   **Real-time Protocol**: ![WebSockets](https://img.shields.io/badge/WebSockets-Socket.io-010101?style=flat-square&logo=socketdotio&logoColor=white)
*   **Message Broker**: ![RabbitMQ](https://img.shields.io/badge/RabbitMQ-FF6600?style=flat-square&logo=rabbitmq&logoColor=white) (AMQP)
*   **Caching & Rate Limiting**: ![Redis](https://img.shields.io/badge/Redis-DC382D?style=flat-square&logo=redis&logoColor=white)

---

## 📌 Yêu Cầu Môi Trường (Prerequisites)

*   [Node.js](https://nodejs.org/) v18.x hoặc v20.x trở lên.
*   [MongoDB](https://www.mongodb.com/) v6.0+ (hoặc chạy qua container Docker).
*   [RabbitMQ](https://www.rabbitmq.com/) v3.11+ (hoặc chạy qua container Docker).
*   [Redis](https://redis.io/) (Dùng cho cache phòng và khóa ghi trùng lắp).

---

## 🚀 Kích Hoạt Dự Án (Getting Started)

1.  **Clone repository và di chuyển vào thư mục:**
    ```bash
    git clone https://github.com/backhaulbid/backhaulbid-bidding-service.git
    cd backhaulbid-bidding-service
    ```

2.  **Cài đặt các gói phụ thuộc:**
    ```bash
    npm install
    ```

3.  **Cấu hình biến môi trường (`.env`):**
    ```powershell
    Copy-Item .env.example .env
    ```
    Sau đó thay các giá trị `change-me-*`. `.env` không được commit; chỉ commit
    `.env.example`.

4.  **Khởi chạy chế độ phát triển (Development):**
    ```bash
    npm run start:dev
    ```
    *Dịch vụ sẽ được khởi chạy tại cổng **`3001`**. Sockets Gateway lắng nghe kết nối tại `ws://localhost:3001`*

5.  **Biên dịch và chạy production:**
    ```bash
    npm run build
    npm run start:prod:bidding
    ```
    Chạy notification-service thay bằng `npm run start:prod:notification`.

### Chức năng bidding hiện tại

- Thống kê theo tài khoản: `GET /api/v1/bidding/statistics/me` cho `SHIPPER` và `CARRIER`; tổng quan toàn hệ thống: `GET /api/v1/bidding/statistics/admin` cho `ADMIN`. Bộ lọc nhận `dateFrom`, `dateTo` và `bucket`.
- Chủ hàng có thể bật `requireCarrierCoverage` cho phiên. Khi đó bidding-service chỉ nhận giá nếu identity-service xác nhận tài khoản nhà xe có chứng từ bảo hiểm trách nhiệm hàng hóa còn hạn và đã được admin duyệt. Bidding-service cần `IDENTITY_SERVICE_URL` và `INTERNAL_SERVICE_TOKEN`; lỗi hoặc timeout của identity-service sẽ từ chối lượt giá.
- `valueDocuments` nhận tối đa 5 chứng từ giá trị hàng. Bidding chỉ lưu khóa object trong thư mục riêng tư `goods-value-docs`; API không trả các khóa này và service không gửi chứng từ cho nhà cung cấp bảo hiểm.

Trong Compose, các URL nội bộ và token giữa service được truyền từ `backhaulbid-infrastructure/docker-compose.yml`. Khi chạy bidding-service độc lập, đặt các biến trên cùng những kết nối MongoDB, Redis, RabbitMQ và wallet trong file `.env`.

---

## 📂 Cơ Cấu Thư Mục (Project Structure)

Dự án được cấu trúc theo kiến trúc Module chuẩn của **NestJS**, nhóm các Controller, Service, Gateway và Model liên quan vào từng module chức năng:

```text
backhaulbid-node-services/
├── apps/
│   ├── bidding/             # REST/WebSocket đấu giá, thống kê, chứng từ giá trị, eligibility nhà xe
│   └── notification/        # REST/WebSocket notification và RabbitMQ consumer
├── package.json             # Script build/start/test cho hai ứng dụng NestJS
├── nest-cli.json            # Khai báo ứng dụng trong monorepo
└── README.md
```

---

## 🐳 Triển Khai Với Docker

Build Docker Image:
```bash
docker build -t backhaulbid-bidding-service:latest .
```

Khi chạy độc lập bằng Docker, `MONGO_URI`, `REDIS_URL`, `RABBITMQ_URL` và
`WALLET_SERVICE_URL` phải dùng hostname mà container có thể truy cập. Trong
stack BackHaulBid, nên khởi chạy từ `backhaulbid-infrastructure` để Compose
truyền đúng các URL nội bộ:
```bash
cd ../backhaulbid-infrastructure
docker compose up -d --build bidding-service
```
