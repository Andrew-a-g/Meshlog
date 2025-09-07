# Dockerfile

FROM php:8.1-apache

# Install PHP MySQL extension
RUN docker-php-ext-install mysqli pdo pdo_mysql

# Copy app code to the Apache webroot
COPY . /var/www/html/

# Ensure config file exists—user to override as needed
RUN cp /var/www/html/config.example.php /var/www/html/config.php

# Adjust any needed permissions
RUN chown -R www-data:www-data /var/www/html

EXPOSE 80
