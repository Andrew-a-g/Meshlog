<?php

class Migration_008 extends Migration {
    public function __construct() {
        parent::__construct(7, 8);
    }

    function migrate($pdo) {
        $pdo->exec("ALTER TABLE `contacts` ADD `multibyte` TINYINT NOT NULL DEFAULT '1' AFTER `hash_size`;");

        return array(
            'success' => true,
            'message' => ''
        );
    }
}

?>