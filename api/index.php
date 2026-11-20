<?php
/**
 * PunctureWala 24x7 — Universal Real-Time PHP Backend
 * Connects Customer App ↔ Admin Panel seamlessly on Hostinger, Apache, LiteSpeed, Nginx.
 */

// Enable CORS
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$dataDir = dirname(__DIR__) . '/data';
if (!is_dir($dataDir)) {
    @mkdir($dataDir, 0777, true);
}

$ordersFile = $dataDir . '/orders.json';
$stateFile  = $dataDir . '/state.json';

// Initialize default orders if not exists (starts fresh with 0 orders)
if (!file_exists($ordersFile)) {
    $defaultOrders = [];
    file_put_contents($ordersFile, json_encode($defaultOrders, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}

// Initialize default state if not exists
if (!file_exists($stateFile)) {
    $defaultState = [
        'vanStatus' => ['free' => true, 'busyMinutes' => 0],
        'mechanicContact' => [
            'name' => 'SANTOSH (ऑन-ड्यूटी)',
            'phone' => '9876543210',
            'tagline' => 'सीधे कॉल करें • 10-15 मिनट में ऑन-साइट पहुँचेगा'
        ],
        'shopLocation' => [
            'name' => 'रमेश टायर & पंचर वर्क्स (मेन वर्कशॉप)',
            'address' => 'शॉप नंबर 4, नियर HP पेट्रोल पंप, NH-48 हाईवे, बिलासपुर (HP)',
            'landmark' => 'HP पेट्रोल पंप के सामने, NH-48',
            'phone' => '9876543210',
            'timings' => '24×7 खुला है (Always Open)',
            'lat' => 31.3985,
            'lng' => 76.8240,
            'distanceKm' => 2.1
        ],
        'mechanicLocs' => [],
        'orderCounter' => 1042
    ];
    file_put_contents($stateFile, json_encode($defaultState, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}

function getOrders() {
    global $ordersFile;
    if (!file_exists($ordersFile)) return [];
    $data = file_get_contents($ordersFile);
    return json_decode($data, true) ?: [];
}

function saveOrders($orders) {
    global $ordersFile;
    file_put_contents($ordersFile, json_encode($orders, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}

function getState() {
    global $stateFile;
    if (!file_exists($stateFile)) return [];
    $data = file_get_contents($stateFile);
    return json_decode($data, true) ?: [];
}

function saveState($state) {
    global $stateFile;
    file_put_contents($stateFile, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}

function getRequestBody() {
    $raw = file_get_contents('php://input');
    return json_decode($raw, true) ?: [];
}

function jsonResponse($data, $code = 200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

// Parse Route
$route = $_GET['route'] ?? '';
$route = trim($route, '/');
if (empty($route)) {
    $uri = $_SERVER['REQUEST_URI'] ?? '';
    $path = parse_url($uri, PHP_URL_PATH);
    $path = preg_replace('#^/api/?#', '', $path);
    $route = trim($path, '/');
}

$method = $_SERVER['REQUEST_METHOD'];

// ── GET /api/orders ──────────────────────────────────────
if ($route === 'orders' && $method === 'GET') {
    jsonResponse(getOrders());
}

// ── POST /api/book ───────────────────────────────────────
if ($route === 'book' && $method === 'POST') {
    $body = getRequestBody();
    $state = getState();
    $counter = ($state['orderCounter'] ?? 1000) + 1;
    $state['orderCounter'] = $counter;
    saveState($state);

    $orderId = 'PW-' . $counter;
    $otp = (string)rand(1000, 9999);

    $order = [
        'id'            => $orderId,
        'otp'           => $otp,
        'customer'      => $body['customer'] ?? 'अज्ञात ग्राहक',
        'phone'         => $body['phone'] ?? 'N/A',
        'service'       => $body['service'] ?? 'पंचर रिपेयर',
        'vehicle'       => $body['vehicle'] ?? 'car',
        'vehicleModel'  => $body['vehicleModel'] ?? '',
        'vehicleNumber' => $body['vehicleNumber'] ?? 'नहीं बताया',
        'distanceKm'    => (float)($body['distanceKm'] ?? 0),
        'distance'      => (float)($body['distanceKm'] ?? 0),
        'amount'        => (int)($body['amount'] ?? 0),
        'vip'           => (bool)($body['vip'] ?? false),
        'address'       => $body['address'] ?? 'वर्तमान स्थान',
        'lat'           => (float)($body['lat'] ?? 31.3985),
        'lng'           => (float)($body['lng'] ?? 76.8240),
        'status'        => 'pending',
        'time'          => date('H:i'),
        'timestamp'     => time() * 1000,
        'otpVerified'   => false
    ];

    $orders = getOrders();
    array_unshift($orders, $order);
    saveOrders($orders);

    jsonResponse([
        'success' => true,
        'orderId' => $orderId,
        'otp'     => $otp,
        'order'   => $order
    ], 200);
}

// ── POST /api/order-status ──────────────────────────────
if ($route === 'order-status' && $method === 'POST') {
    $body = getRequestBody();
    $orders = getOrders();
    $found = false;

    foreach ($orders as &$o) {
        if ($o['id'] === ($body['id'] ?? '')) {
            $o['status'] = $body['status'] ?? $o['status'];
            if (!empty($body['reason'])) $o['cancelReason'] = $body['reason'];
            if ($o['status'] === 'pending' || $o['status'] === 'accepted') {
                $o['otpVerified'] = false;
            }
            $found = $o;
            break;
        }
    }

    if ($found) {
        saveOrders($orders);
        jsonResponse(['success' => true, 'order' => $found]);
    } else {
        jsonResponse(['error' => 'Order not found'], 404);
    }
}

// ── POST /api/verify-otp ────────────────────────────────
if ($route === 'verify-otp' && $method === 'POST') {
    $body = getRequestBody();
    $orderId = trim((string)($body['orderId'] ?? ''));
    $inputOtp = trim((string)($body['otp'] ?? ''));

    if (empty($orderId) || empty($inputOtp)) {
        jsonResponse([
            'success' => false,
            'verified' => false,
            'error' => 'Order ID और 4-अंकों का OTP दोनों आवश्यक हैं'
        ], 200);
    }

    $orders = getOrders();
    $matched = false;
    foreach ($orders as &$o) {
        if ($o['id'] === $orderId) {
            $matched = true;
            $savedOtp = trim((string)($o['otp'] ?? ''));
            // Check matching OTP or master test PIN '1234'
            if (($savedOtp !== '' && $savedOtp === $inputOtp) || $inputOtp === '1234') {
                $o['otpVerified'] = true;
                $o['status'] = 'active'; // OTP verified -> work started
                saveOrders($orders);
                jsonResponse([
                    'success' => true,
                    'verified' => true,
                    'order' => $o
                ], 200);
            } else {
                jsonResponse([
                    'success' => false,
                    'verified' => false,
                    'error' => 'गलत OTP दर्ज किया गया है! कृपया ग्राहक की स्क्रीन देखकर सही OTP डालें।'
                ], 200);
            }
            break;
        }
    }
    if (!$matched) {
        if ($inputOtp === '1234') {
            jsonResponse([
                'success' => true,
                'verified' => true,
                'order' => ['id' => $orderId, 'status' => 'active', 'otpVerified' => true]
            ], 200);
        }
        jsonResponse([
            'success' => false,
            'verified' => false,
            'error' => 'ऑर्डर नहीं मिला (Order ID अमान्य है)'
        ], 200);
    }
}

// ── GET/POST /api/van-status ────────────────────────────
if ($route === 'van-status') {
    $state = getState();
    if ($method === 'GET') {
        jsonResponse($state['vanStatus'] ?? ['free' => true, 'busyMinutes' => 0]);
    }
    if ($method === 'POST') {
        $body = getRequestBody();
        $state['vanStatus'] = array_merge($state['vanStatus'] ?? [], $body);
        saveState($state);
        jsonResponse(['success' => true, 'vanStatus' => $state['vanStatus']]);
    }
}

// ── GET/POST /api/mechanic-location ────────────────────
if ($route === 'mechanic-location') {
    $state = getState();
    if ($method === 'GET') {
        $orderId = $_GET['orderId'] ?? '';
        jsonResponse($state['mechanicLocs'][$orderId] ?? ['error' => 'No location for order']);
    }
    if ($method === 'POST') {
        $body = getRequestBody();
        $orderId = $body['orderId'] ?? '';
        if ($orderId) {
            $state['mechanicLocs'][$orderId] = [
                'lat' => $body['lat'] ?? 0,
                'lng' => $body['lng'] ?? 0,
                'orderId' => $orderId,
                'ts' => time() * 1000
            ];
            saveState($state);
        }
        jsonResponse(['success' => true]);
    }
}

// ── POST /api/mechanic-started ─────────────────────────
if ($route === 'mechanic-started' && $method === 'POST') {
    $body = getRequestBody();
    $orderId = $body['orderId'] ?? '';
    $orders = getOrders();
    foreach ($orders as &$o) {
        if ($o['id'] === $orderId) {
            $o['status'] = 'onway';
            saveOrders($orders);
            jsonResponse(['success' => true, 'order' => $o]);
        }
    }
    jsonResponse(['success' => true]);
}

// ── GET/POST /api/mechanic-contact ─────────────────────
if ($route === 'mechanic-contact') {
    $state = getState();
    if ($method === 'GET') {
        jsonResponse($state['mechanicContact'] ?? []);
    }
    if ($method === 'POST') {
        $body = getRequestBody();
        $state['mechanicContact'] = array_merge($state['mechanicContact'] ?? [], $body);
        saveState($state);
        jsonResponse(['success' => true, 'mechanicContact' => $state['mechanicContact']]);
    }
}

// ── GET/POST /api/shop-location ────────────────────────
if ($route === 'shop-location') {
    $state = getState();
    if ($method === 'GET') {
        jsonResponse($state['shopLocation'] ?? []);
    }
    if ($method === 'POST') {
        $body = getRequestBody();
        $state['shopLocation'] = array_merge($state['shopLocation'] ?? [], $body);
        saveState($state);
        jsonResponse(['success' => true, 'shopLocation' => $state['shopLocation']]);
    }
}

// ── GET /api/track/:orderId ────────────────────────────
if (strpos($route, 'track') === 0 && $method === 'GET') {
    $parts = explode('/', $route);
    $orderId = $parts[1] ?? ($_GET['orderId'] ?? '');
    $orders = getOrders();
    $state = getState();

    foreach ($orders as $o) {
        if ($o['id'] === $orderId) {
            $loc = $state['mechanicLocs'][$orderId] ?? null;
            jsonResponse([
                'success' => true,
                'order' => $o,
                'location' => $loc,
                'status' => $o['status']
            ]);
        }
    }
    jsonResponse(['error' => 'Order not found'], 404);
}

// ── GET /api/events (SSE Stream Pulse — Fast & Non-Blocking for Hostinger/LiteSpeed) ──
if ($route === 'events' && $method === 'GET') {
    if (function_exists('apache_setenv')) {
        @apache_setenv('no-gzip', 1);
    }
    @ini_set('zlib.output_compression', 0);
    @ini_set('implicit_flush', 1);
    while (ob_get_level() > 0) {
        @ob_end_clean();
    }

    header("Content-Type: text/event-stream; charset=utf-8");
    header("Cache-Control: no-cache, no-store, must-revalidate");
    header("Pragma: no-cache");
    header("Connection: close");
    header("X-Accel-Buffering: no");

    $orders = getOrders();
    $state = getState();

    echo "event: connected\ndata: {\"msg\":\"Connected to Live Server\"}\n\n";
    echo "event: all-orders\ndata: " . json_encode($orders, JSON_UNESCAPED_UNICODE) . "\n\n";
    if (!empty($state['vanStatus'])) {
        echo "event: van-status\ndata: " . json_encode($state['vanStatus']) . "\n\n";
    }
    if (!empty($state['mechanicContact'])) {
        echo "event: mechanic-contact-updated\ndata: " . json_encode($state['mechanicContact']) . "\n\n";
    }
    if (!empty($state['shopLocation'])) {
        echo "event: shop-location-updated\ndata: " . json_encode($state['shopLocation']) . "\n\n";
    }
    echo "retry: 3000\n\n";
    @flush();
    exit;
}

// ── POST/GET /api/clear-orders (Admin clears all orders) ──
if ($route === 'clear-orders' && ($method === 'POST' || $method === 'GET')) {
    saveOrders([]);
    $state = getState();
    $state['mechanicLocs'] = [];
    saveState($state);
    jsonResponse(['success' => true, 'message' => 'All orders cleared successfully', 'orders' => []]);
}

// ── POST/GET /api/delete-order (Admin deletes single order permanently) ──
if ($route === 'delete-order' && ($method === 'POST' || $method === 'GET')) {
    $body = getRequestBody();
    $orderId = $body['orderId'] ?? ($body['id'] ?? ($_GET['orderId'] ?? ''));
    if ($orderId) {
        $orders = getOrders();
        $orders = array_values(array_filter($orders, function($o) use ($orderId) {
            return $o['id'] !== $orderId;
        }));
        saveOrders($orders);
        $state = getState();
        if (isset($state['mechanicLocs'][$orderId])) {
            unset($state['mechanicLocs'][$orderId]);
            saveState($state);
        }
    }
    jsonResponse(['success' => true, 'orderId' => $orderId, 'orders' => getOrders()]);
}

// Default 404
jsonResponse(['error' => 'Endpoint not found', 'route' => $route], 404);
