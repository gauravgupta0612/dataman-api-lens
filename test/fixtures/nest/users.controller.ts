import { Controller, Get, Post, Body, Param, Query, Headers } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';

export class CreateUserDto {
  @IsString()
  name: string;
  email: string;
  @IsOptional()
  age?: number;
  roles: string[];
}

@Controller('users')
export class UsersController {
  @Get(':id')
  findOne(@Param('id') id: string, @Query('expand') expand?: string) {}

  @Post()
  create(@Body() dto: CreateUserDto, @Headers('x-tenant') tenant: string) {}
}
