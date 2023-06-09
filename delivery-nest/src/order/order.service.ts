import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Order } from './order.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { Product } from '../product/product.entity';
import { User } from '../user/user.entity';
import { OrderItem } from '../order-item/order-item.entity';
import { DataSource } from 'typeorm';
import { validate } from 'class-validator';
import { GetByContactOrderDto } from './dto/order.dto';
@Injectable()
export class OrderService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
  ) {}

  async getAll(): Promise<Order[]> {
    return this.orderRepository.find();
  }

  async getById(id: number): Promise<Order> {
    const order = await this.orderRepository.findOne({
      relations: ['orderItems', 'orderItems.product', 'user'],
      where: { id },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return order;
  }

  async getByContactInfo(
    getByContactOrderDto: GetByContactOrderDto,
  ): Promise<Order[]> | null {
    const query = this.userRepository.createQueryBuilder('user');
    query.where('user.phone = :phone OR user.email = :email', {
      phone: getByContactOrderDto.phone,
      email: getByContactOrderDto.email,
    });

    const user = await query.getOne();

    if (!user || !Object.keys(getByContactOrderDto).length) {
      throw new NotFoundException(`User not found`);
    }

    const orders = await this.orderRepository.find({
      relations: [
        'orderItems',
        'orderItems.product',
        'orderItems.product.shop',
        'user',
      ],
      where: { user: { id: user.id } },
    });

    return orders;
  }

  async create(createOrderDto: CreateOrderDto): Promise<Order> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const orderItemsList: OrderItem[] = [];

    const order = new Order();

    const user = await this.userRepository.findOne({
      where: { id: createOrderDto.userId },
    });

    if (!user) {
      throw new NotFoundException(`User ${createOrderDto.userId} not found`);
    }

    order.user = user;
    order.latitude = createOrderDto.latitude;
    order.longitude = createOrderDto.longitude;

    try {
      for await (const item of createOrderDto.orderItems) {
        const orderItem = new OrderItem();

        const product = await this.productRepository
          .createQueryBuilder('product')
          .where('product.id = :id', { id: item.productId })
          .getOne();

        if (!product) {
          throw new NotFoundException(
            `Product with id ${item.productId} not found`,
          );
        }

        orderItem.quantity = item.quantity;
        orderItem.price = product.price * item.quantity;
        orderItem.product = product;

        const errors = await validate(orderItem);
        if (errors.length > 0) {
          throw new BadRequestException(errors);
        }

        const resOrderItem = await queryRunner.manager.save(orderItem);
        orderItemsList.push(resOrderItem);
      }

      order.orderItems = orderItemsList;

      const errors = await validate(order);
      if (errors.length > 0) {
        throw new BadRequestException(errors);
      }

      const res = await queryRunner.manager.save(order);

      await queryRunner.commitTransaction();
      return res;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      throw new NotFoundException(error);
    } finally {
      await queryRunner.release();
    }
  }
}
