<?php

class Migration_009 extends Migration {
    public function __construct() {
        parent::__construct(8, 9);
    }

    function migrate($pdo) {
        $pdo->exec("ALTER TABLE `channels` ADD `secret` VARCHAR(64) DEFAULT NULL AFTER `hash`;");

        return array(
            'success' => true,
            'message' => ''
        );
    }
}

?>
