<?php
// PunctureWala 24x7 - Fallback router for servers looking for index.php
if (file_exists(__DIR__ . '/index.html')) {
    include __DIR__ . '/index.html';
    exit;
}
