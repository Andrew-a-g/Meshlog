<?php
session_start();
require_once 'config.php';

// --- Simple login handling ---
if (!isset($_SESSION['logged_in'])) {
    if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['login'])) {
        $user = $_POST['username'] ?? '';
        $pass = $_POST['password'] ?? '';

        // Compare against DB credentials from environment
        $dbUser = getenv('MESHLOG_DB_USER') ?: 'meshuser';
        $dbPass = getenv('MESHLOG_DB_PASS') ?: 'meshpass';

        if ($user === $dbUser && $pass === $dbPass) {
            $_SESSION['logged_in'] = true;
        } else {
            $error = "Invalid login.";
        }
    }

    if (!isset($_SESSION['logged_in'])) {
        ?>
        <!DOCTYPE html>
        <html>
        <head><title>Reporter Login</title></head>
        <body>
            <h2>Login to Add Reporter</h2>
            <?php if (!empty($error)) echo "<p style='color:red;'>$error</p>"; ?>
            <form method="post">
                <label>Username: <input type="text" name="username"></label><br>
                <label>Password: <input type="password" name="password"></label><br>
                <button type="submit" name="login">Login</button>
            </form>
        </body>
        </html>
        <?php
        exit;
    }
}

// --- If logged in, handle reporter insert ---
$pdo = openPdo();
$message = "";

if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['add_reporter'])) {
    $stmt = $pdo->prepare("
        INSERT INTO reporters (name, public_key, lat, lon, auth, authorized, color)
        VALUES (:name, :public_key, :lat, :lon, :auth, :authorized, :color)
    ");

    try {
        $stmt->execute([
            ':name'       => $_POST['name'],
            ':public_key' => $_POST['public_key'],
            ':lat'        => $_POST['lat'],
            ':lon'        => $_POST['lon'],
            ':auth'       => $_POST['auth'],
            ':authorized' => isset($_POST['authorized']) ? 1 : 0,
            ':color'      => $_POST['color']
        ]);
        $message = "Reporter added successfully!";
    } catch (PDOException $e) {
        $message = "Error: " . $e->getMessage();
    }
}
?>

<!DOCTYPE html>
<html>
<head>
    <title>Add Reporter</title>
</head>
<body>
    <h2>Add Reporter</h2>
    <?php if (!empty($message)) echo "<p><strong>$message</strong></p>"; ?>
    <form method="post">
        <label>Name: <input type="text" name="name" required></label><br>
        <label>Public Key: <input type="text" name="public_key" required></label><br>
        <label>Latitude: <input type="text" name="lat" required></label><br>
        <label>Longitude: <input type="text" name="lon" required></label><br>
        <label>Auth: <input type="text" name="auth" required></label><br>
        <label>Authorized: <input type="checkbox" name="authorized" value="1"></label><br>
        <label>Color: <input type="text" name="color" required></label><br><br>
        <button type="submit" name="add_reporter">Add Reporter</button>
    </form>
</body>
</html>
